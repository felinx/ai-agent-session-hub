import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, initSchema, replaceSession } from '../src/db.js';
import { collectStatus, formatStatus } from '../src/status.js';

function serveOnce(body) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function closedPort() {
  const server = await serveOnce({});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('collectStatus prefers the live status API', async () => {
  const agent = { agent: 'claude', sessions: 2, messages: 3, lastSyncAt: 111, latest: null };
  const server = await serveOnce({ scanning: false, lastSyncAt: 111, agents: [agent], totals: { sessions: 2, messages: 3 } });
  try {
    const status = await collectStatus({
      config: { host: '127.0.0.1', port: server.address().port, dbPath: '/nonexistent/hub.db' }
    });
    assert.equal(status.running, true);
    assert.equal(status.source, 'http');
    assert.equal(status.lastSyncAt, 111);
    assert.deepEqual(status.agents, [agent]);
    assert.deepEqual(status.totals, { sessions: 2, messages: 3 });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('collectStatus falls back to the local copy when the server is down', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-status-'));
  const dbPath = path.join(dir, 'hub.db');
  const db = openDb(dbPath);
  initSchema(db);
  replaceSession(db, {
    key: 'k1', agent: 'claude', nativeId: 'n1', title: 't',
    updatedAt: 1234, sourcePath: path.join(dir, 'source.jsonl')
  }, [{ role: 'user', text: 'hello' }], { mtimeMs: 1, size: 1 });
  db.close();

  const status = await collectStatus({ config: { host: '127.0.0.1', port: await closedPort(), dbPath } });

  assert.equal(status.running, false);
  assert.equal(status.source, 'db');
  assert.equal(status.lastSyncAt, 1234);
  assert.deepEqual(status.totals, { sessions: 1, messages: 1 });
  assert.equal(status.agents[0].agent, 'claude');
});

test('collectStatus reports an empty hub when there is no local copy yet', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-status-'));
  const status = await collectStatus({
    config: { host: '127.0.0.1', port: await closedPort(), dbPath: path.join(dir, 'missing.db') }
  });
  assert.deepEqual(status, {
    running: false,
    host: '127.0.0.1',
    port: status.port,
    source: 'none',
    lastSyncAt: null,
    agents: [],
    totals: { sessions: 0, messages: 0 }
  });
});

test('formatStatus prints live and stopped summaries', () => {
  const live = formatStatus({
    running: true,
    host: '127.0.0.1',
    port: 7317,
    source: 'http',
    lastSyncAt: 1764000000000,
    totals: { sessions: 3, messages: 42 },
    agents: [{
      agent: 'claude', sessions: 3, messages: 42, lastSyncAt: 1764000000000,
      latest: { id: 'abcd1234', summary: 'latest words' }
    }]
  });
  assert.match(live, /running/);
  assert.match(live, /127\.0\.0\.1:7317/);
  assert.match(live, /Sessions: 3\s+Messages: 42/);
  assert.match(live, /claude\s+3\s+42/);
  assert.match(live, /abcd1234\s+latest words/);

  const empty = formatStatus({
    running: false, host: '127.0.0.1', port: 7317, source: 'none',
    lastSyncAt: null, totals: { sessions: 0, messages: 0 }, agents: []
  });
  assert.match(empty, /stopped/);
  assert.match(empty, /No sessions synced yet/);
});

test('hub URLs bracket IPv6 hosts and hide wildcard binds', async () => {
  const { hubUrl } = await import('../src/status.js');
  assert.equal(hubUrl('::1', 7317), 'http://[::1]:7317');
  assert.equal(hubUrl('0.0.0.0', 7317), 'http://127.0.0.1:7317');
  assert.equal(hubUrl('127.0.0.1', 7317), 'http://127.0.0.1:7317');

  const lines = formatStatus({
    running: true, host: '::1', port: 7317, source: 'http', lastSyncAt: null,
    totals: { sessions: 0, messages: 0 }, agents: []
  });
  assert.match(lines, /http:\/\/\[::1\]:7317/);
});
