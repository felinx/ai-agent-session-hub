import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDaemon, isAlive, liveDaemon, stopDaemon, removeDaemonFile } from '../src/daemon.js';

const bin = path.join(import.meta.dirname, '..', 'bin', 'session-hub.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('readDaemon ignores missing and malformed pid files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-daemon-'));
  assert.equal(readDaemon(path.join(dir, 'hub.pid')), null);

  const pidPath = path.join(dir, 'hub.pid');
  writeFileSync(pidPath, 'not json');
  assert.equal(readDaemon(pidPath), null);

  writeFileSync(pidPath, JSON.stringify({ pid: 'abc' }));
  assert.equal(readDaemon(pidPath), null);

  writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port: 7317, startedAt: 1 }));
  assert.deepEqual(readDaemon(pidPath), { pid: process.pid, port: 7317, startedAt: 1 });
});

test('isAlive recognises the current process and rejects dead pids', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 22 + 12345), false);
});

test('background start, duplicate start, restart, and stop', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-daemon-'));
  const none = path.join(dir, 'none');
  const pidPath = path.join(dir, 'hub.pid');
  const port = String(await freePort());
  const env = {
    ...process.env,
    SESSION_HUB_DB: path.join(dir, 'hub.db'),
    SESSION_HUB_PORT: port,
    CLAUDE_HOME: none,
    CODEX_HOME: none,
    DSH_HOME: none,
    WORKBUDDY_HOME: none,
    LARK_CHANNEL_HOME: none
  };
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });

  try {
    const started = run('start');
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /started/i);

    const info = readDaemon(pidPath);
    assert.ok(info, 'expected a pid file');
    assert.equal(info.port, Number(port));
    assert.equal(isAlive(info.pid), true);

    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);

    const duplicate = run('start');
    assert.equal(duplicate.status, 0);
    assert.match(duplicate.stdout, /already running/i);
    assert.equal(readDaemon(pidPath).pid, info.pid);

    const restarted = run('restart');
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /started/i);
    const restartedInfo = readDaemon(pidPath);
    assert.notEqual(restartedInfo.pid, info.pid);
    assert.equal(isAlive(restartedInfo.pid), true);

    const stopped = run('stop');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/i);
    assert.equal(existsSync(pidPath), false);
    assert.equal(isAlive(restartedInfo.pid), false);
  } finally {
    const leftover = readDaemon(pidPath);
    if (leftover) {
      try { process.kill(leftover.pid, 'SIGKILL'); } catch {}
    }
  }
});

test('stop reports a hub that is not running', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-daemon-'));
  const env = { ...process.env, SESSION_HUB_DB: path.join(dir, 'hub.db') };
  const stopped = spawnSync(process.execPath, [bin, 'stop'], { env, encoding: 'utf8' });
  assert.equal(stopped.status, 0);
  assert.match(`${stopped.stdout}${stopped.stderr}`, /not running/i);
});

test('liveDaemon treats a recycled pid as stale', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-daemon-'));
  const pidPath = path.join(dir, 'hub.pid');

  writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port: 7317, startedAt: 1 }));
  assert.equal(liveDaemon(pidPath, { commandOf: () => 'node /usr/bin/unrelated' }), null);
  assert.equal(existsSync(pidPath), false);

  writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port: 7317, startedAt: 1 }));
  assert.equal(liveDaemon(pidPath, { commandOf: () => 'node /repo/bin/session-hub.js run' }).pid, process.pid);
  removeDaemonFile(pidPath);
});

test('stopDaemon never signals a process that is not the hub', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-daemon-'));
  const pidPath = path.join(dir, 'hub.pid');
  writeFileSync(pidPath, JSON.stringify({ pid: process.pid, port: 7317, startedAt: 1 }));

  let killed = false;
  const result = await stopDaemon({
    pidPath,
    commandOf: () => 'node /usr/bin/unrelated',
    kill: () => { killed = true; }
  });

  assert.equal(result.stopped, false);
  assert.equal(result.stale, true);
  assert.equal(killed, false);
  assert.equal(existsSync(pidPath), false);
});
