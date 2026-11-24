import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultEntry = fileURLToPath(new URL('../bin/session-hub.js', import.meta.url));

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function readDaemon(pidPath) {
  let raw;
  try {
    raw = readFileSync(pidPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const info = JSON.parse(raw);
    if (!Number.isInteger(info?.pid) || info.pid <= 0) return null;
    return { pid: info.pid, port: info.port ?? null, startedAt: info.startedAt ?? null };
  } catch {
    return null;
  }
}

// Signal 0 only checks for existence. EPERM means the process exists but belongs to
// another user, which still counts as alive.
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function writeDaemonFile(pidPath, info) {
  mkdirSync(path.dirname(pidPath), { recursive: true, mode: 0o700 });
  writeFileSync(pidPath, JSON.stringify(info), { mode: 0o600 });
  try { chmodSync(pidPath, 0o600); } catch {}
}

// Only remove the file when it still describes `pid`, so a stale process cannot
// clear a fresh daemon's pid file.
export function removeDaemonFile(pidPath, pid) {
  if (pid !== undefined) {
    const info = readDaemon(pidPath);
    if (!info || info.pid !== pid) return;
  }
  try { unlinkSync(pidPath); } catch {}
}

export function liveDaemon(pidPath) {
  const info = readDaemon(pidPath);
  if (!info) return null;
  if (isAlive(info.pid)) return info;
  removeDaemonFile(pidPath, info.pid);
  return null;
}

// Detach a `session-hub run` child and wait until it has written its pid file, which
// the child does only after the server is listening.
export async function startDaemon({
  config,
  entry = defaultEntry,
  env = process.env,
  spawnImpl = spawn,
  timeoutMs = 8000,
  sleep = defaultSleep
}) {
  const running = liveDaemon(config.pidPath);
  if (running) return { alreadyRunning: true, info: running };

  const args = [entry, 'run', '--host', config.host, '--port', String(config.port), '--db', config.dbPath];
  if (config.rebuild) args.push('--rebuild');

  const child = spawnImpl(
    process.execPath,
    args,
    { detached: true, stdio: 'ignore', env: { ...env, SESSION_HUB_DAEMON: '1' } }
  );
  child.unref();

  let failure = null;
  child.once('error', (error) => { failure = error; });
  child.once('exit', (code, signal) => {
    failure ??= new Error(`hub exited during startup (${code ?? signal})`);
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const info = readDaemon(config.pidPath);
    if (info && info.pid === child.pid) return { alreadyRunning: false, info };
    await sleep(50);
  }

  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  const error = new Error('hub did not start in time');
  error.code = 'daemonTimeout';
  throw error;
}

// Stop only the process recorded in our own pid file. SIGTERM first, SIGKILL if it is
// still there after the grace period.
export async function stopDaemon({
  pidPath,
  timeoutMs = 8000,
  kill = process.kill,
  sleep = defaultSleep
}) {
  const info = readDaemon(pidPath);
  if (!info) return { stopped: false };

  if (!isAlive(info.pid)) {
    removeDaemonFile(pidPath, info.pid);
    return { stopped: false, stale: true, info };
  }

  try {
    kill(info.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      removeDaemonFile(pidPath, info.pid);
      return { stopped: false, stale: true, info };
    }
    throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(info.pid)) {
      removeDaemonFile(pidPath, info.pid);
      return { stopped: true, info };
    }
    await sleep(50);
  }

  try { kill(info.pid, 'SIGKILL'); } catch {}
  await sleep(200);
  removeDaemonFile(pidPath, info.pid);
  return { stopped: true, forced: true, info };
}
