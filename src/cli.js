import { readFileSync } from 'node:fs';
import { parseArgs } from './args.js';
import { loadConfig } from './config.js';
import { startHub, defaultPublicDir } from './hub.js';
import { createLogStore } from './log-file.js';
import { collectStatus, formatStatus } from './status.js';
import { startDaemon, stopDaemon, writeDaemonFile, removeDaemonFile } from './daemon.js';
import { tailLines, clearLogs, followLogs } from './logs.js';
import { runDoctor, formatChecks } from './doctor.js';
import { stamp } from './log.js';
import { resolveLanguage, t, detectSystemLanguage } from '../web/i18n.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `Usage: session-hub <command> [options]

Commands:
  start      Start the hub in the background (default)
  run        Run the hub in the foreground
  stop       Stop the background hub
  restart    Restart the background hub
  status     Show whether the hub is running and per-agent totals
  logs       Show or clear the hub log files
  doctor     Check the local setup
  help       Show this help

Options:
  --port <n>     Listen port (default 7317)
  --host <addr>  Listen address (default 127.0.0.1)
  --db <path>    Local copy database (default ~/.session-hub/hub.db)
  --rebuild      Rebuild the local copy from the source sessions

Environment:
  SESSION_HUB_PORT, SESSION_HUB_HOST, SESSION_HUB_DB, SESSION_HUB_LOG_DIR,
  CLAUDE_HOME, CODEX_HOME, DSH_HOME, WORKBUDDY_HOME, LARK_CHANNEL_HOME`;

const ERROR_TEXT = {
  unknownCommand: arg => `unknown command "${arg}"`,
  unknownOption: arg => `unknown option "${arg}"`,
  missingValue: arg => `option "${arg}" needs a value`,
  invalidPort: arg => `invalid port "${arg}"`,
  invalidLines: arg => `invalid line count "${arg}"`
};

function describeError(error) {
  const format = ERROR_TEXT[error?.code];
  return format ? format(error.arg) : 'invalid arguments';
}

async function runCommand(options, io) {
  const config = loadConfig(io.env, options);
  const store = createLogStore({ dir: config.logDir });
  const quiet = io.env.SESSION_HUB_DAEMON === '1';

  // Every log line goes to the rotating log files; the terminal also sees it unless
  // this process is the detached daemon, where the log files are the only record.
  const emit = (line, level = 'info') => {
    store.write(line);
    if (quiet) return;
    if (level === 'info') io.out(line);
    else io.err(line);
  };

  const start = io.startHub ?? startHub;
  let hub;
  try {
    hub = await start({
      config,
      publicDir: io.publicDir ?? defaultPublicDir,
      emit,
      syncInterval: io.syncInterval ?? 5000
    });
  } catch (error) {
    emit(`${stamp()} ${error?.message ?? error}`, 'error');
    return 1;
  }

  if (quiet) {
    // The detached child owns the pid file for exactly as long as it is serving.
    writeDaemonFile(config.pidPath, { pid: process.pid, port: hub.port, startedAt: Date.now() });
    process.once('exit', () => removeDaemonFile(config.pidPath, process.pid));
  }

  if (io.noWait) return 0;

  await new Promise(resolve => {
    const shutdown = (signal) => {
      const lang = hub.language ? hub.language() : resolveLanguage('system', detectSystemLanguage());
      emit(`${stamp()} ${t(lang, 'server.shutdown', { signal })}`);
      resolve();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });

  await hub.close();
  return 0;
}

async function statusCommand(options, io) {
  const config = loadConfig(io.env, options);
  const collect = io.collectStatus ?? collectStatus;
  const status = await collect({ config });

  if (options.json) io.out(JSON.stringify(status, null, 2));
  else io.out(formatStatus(status));

  return status.running ? 0 : 1;
}

async function startCommand(options, io) {
  const config = loadConfig(io.env, options);
  const start = io.startDaemon ?? startDaemon;

  let result;
  try {
    result = await start({ config, env: io.env });
  } catch (error) {
    io.err(`session-hub: the hub failed to start: ${error?.message ?? error}`);
    io.err(`Check the log files in ${config.logDir}`);
    return 1;
  }

  if (result.alreadyRunning) {
    io.out(`Hub is already running (pid ${result.info.pid}) → http://${config.host}:${result.info.port}`);
    return 0;
  }
  io.out(`Hub started in the background (pid ${result.info.pid}) → http://${config.host}:${result.info.port}`);
  io.out(`Logs: ${config.logDir}`);
  return 0;
}

async function stopCommand(options, io) {
  const config = loadConfig(io.env, options);
  const result = await (io.stopDaemon ?? stopDaemon)({ pidPath: config.pidPath });

  if (result.stopped) {
    io.out(`Hub stopped${result.forced ? ' (forced)' : ''} (pid ${result.info.pid})`);
  } else if (result.stale) {
    io.out('Hub is not running (removed a stale pid file)');
  } else {
    io.out('Hub is not running');
  }
  return 0;
}

async function restartCommand(options, io) {
  const stopped = await stopCommand(options, io);
  if (stopped !== 0) return stopped;
  return startCommand(options, io);
}

async function logsCommand(options, io) {
  const config = loadConfig(io.env, options);

  if (options.clear) {
    const count = (io.clearLogs ?? clearLogs)(config.logDir);
    io.out(count > 0
      ? `Cleared ${count} log file(s) in ${config.logDir}`
      : `No log files in ${config.logDir}`);
    return 0;
  }

  const lines = (io.tailLines ?? tailLines)(config.logDir, options.lines ?? 50);
  if (lines.length === 0) {
    io.out(`No log files in ${config.logDir}`);
    return 0;
  }
  for (const line of lines) io.out(line);

  if (options.follow) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await followLogs(config.logDir, { out: io.out, signal: controller.signal, fromEnd: true });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  return 0;
}

async function doctorCommand(options, io) {
  const config = loadConfig(io.env, options);
  const checks = await (io.runDoctor ?? runDoctor)({ config });
  io.out(formatChecks(checks));
  return checks.some(check => check.level === 'fail') ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  const context = { ...io, env, out, err };

  const { command, options, errors } = parseArgs(argv);

  if (errors.length > 0) {
    for (const error of errors) err(`session-hub: ${describeError(error)}`);
    err(HELP);
    return 2;
  }

  switch (command) {
    case 'help':
      out(HELP);
      return 0;
    case 'version':
      out(`session-hub ${pkg.version}`);
      return 0;
    case 'run':
      return runCommand(options, context);
    case 'start':
      return startCommand(options, context);
    case 'stop':
      return stopCommand(options, context);
    case 'restart':
      return restartCommand(options, context);
    case 'status':
      return statusCommand(options, context);
    case 'logs':
      return logsCommand(options, context);
    case 'doctor':
      return doctorCommand(options, context);
    default:
      err(`session-hub: command "${command}" is not implemented yet`);
      return 1;
  }
}
