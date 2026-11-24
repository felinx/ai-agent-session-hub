import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, initSchema } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { runDoctor, formatChecks } from '../src/doctor.js';

async function closedPort() {
  const net = await import('node:net');
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('runDoctor reports node, database, logs, sources, and server state', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-doctor-'));
  const dbPath = path.join(dir, 'hub.db');
  const db = openDb(dbPath);
  initSchema(db);
  db.close();

  const claude = path.join(dir, 'claude');
  const missing = path.join(dir, 'missing');
  const config = {
    ...loadConfig({
      SESSION_HUB_DB: dbPath,
      CLAUDE_HOME: claude,
      CODEX_HOME: missing,
      DSH_HOME: missing,
      WORKBUDDY_HOME: missing,
      LARK_CHANNEL_HOME: missing
    }, {}),
    port: await closedPort()
  };

  const checks = await runDoctor({ config, nodeVersion: '22.5.0' });
  const byLabel = Object.fromEntries(checks.map(check => [check.label, check]));

  assert.equal(byLabel['Node.js'].level, 'ok');
  assert.equal(byLabel['Database'].level, 'ok');
  assert.match(byLabel['Database'].detail, /0 sessions/);
  assert.equal(byLabel['Logs'].level, 'ok');
  assert.equal(byLabel['Source: claude'].level, 'warn');
  assert.equal(byLabel['Source: codex'].level, 'warn');
  assert.equal(byLabel['Server'].level, 'warn');

  assert.match(formatChecks(checks), /^\[ok\] Node\.js:/m);
  assert.match(formatChecks(checks), /^\[warn\] Server:/m);
});

test('runDoctor fails on an unsupported Node.js version', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-doctor-'));
  const config = {
    ...loadConfig({ SESSION_HUB_DB: path.join(dir, 'hub.db') }, {}),
    port: await closedPort()
  };
  const checks = await runDoctor({ config, nodeVersion: '20.11.0' });
  assert.equal(checks.find(check => check.label === 'Node.js').level, 'fail');
});
