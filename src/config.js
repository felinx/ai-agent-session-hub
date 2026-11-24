import os from 'node:os';
import path from 'node:path';

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// Runtime configuration: command-line options win over environment variables,
// which win over the defaults. Everything derived from the database stays next
// to it, so pointing SESSION_HUB_DB somewhere else moves the whole hub state.
export function loadConfig(env = process.env, options = {}) {
  const home = os.homedir();
  const dbPath = options.db || env.SESSION_HUB_DB || path.join(home, '.session-hub', 'hub.db');
  const stateDir = path.dirname(dbPath);

  return {
    host: options.host || env.SESSION_HUB_HOST || '127.0.0.1',
    port: validPort(options.port) ?? validPort(env.SESSION_HUB_PORT) ?? 7317,
    dbPath,
    logDir: env.SESSION_HUB_LOG_DIR || path.join(stateDir, 'logs'),
    pidPath: path.join(stateDir, 'hub.pid'),
    rebuild: !!options.rebuild,
    roots: {
      claude: env.CLAUDE_HOME || path.join(home, '.claude'),
      codex: env.CODEX_HOME || path.join(home, '.codex'),
      dsh: env.DSH_HOME || path.join(home, '.dsh'),
      workbuddy: env.WORKBUDDY_HOME || path.join(home, '.workbuddy'),
      larkChannel: env.LARK_CHANNEL_HOME || path.join(home, '.lark-channel')
    }
  };
}
