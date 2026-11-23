import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, initSchema, replaceSession } from '../src/db.js';
import { createServer } from '../src/server.js';

function seed(db) {
  const base = {
    createdAt: 1, sourcePath: '/x', archived: 0, messageCount: 2,
    tokens: null, extraJson: null
  };
  replaceSession(db, {
    ...base, key: 'claude:a', agent: 'claude', nativeId: 'a', title: '构建',
    cwd: '/p1', chatId: 'oc_A', updatedAt: 300, sourcePath: '/x/a.jsonl'
  }, [
    { role: 'user', text: '这个项目为什么构建失败' },
    { role: 'assistant', text: '我看一下' }
  ], { mtimeMs: 300, size: 1 });

  replaceSession(db, {
    ...base, key: 'codex:b', agent: 'codex', nativeId: 'b', title: '聚合',
    cwd: '/p2', chatId: null, updatedAt: 200, sourcePath: '/x/b.jsonl'
  }, [
    { role: 'user', text: '会话聚合' },
    { role: 'assistant', text: '好的' }
  ], { mtimeMs: 200, size: 1 });
}

async function makeServer() {
  const db = openDb(':memory:');
  initSchema(db);
  seed(db);

  const publicDir = mkdtempSync(path.join(tmpdir(), 'session-hub-public-'));
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><div id="app"></div>');

  const state = { scanning: false, lastSyncAt: null, warnings: [] };
  const server = createServer({ db, state, publicDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); }))
  };
}

test('GET /api/sessions 返回列表与 facets', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const res = await fetch(s.base + '/api/sessions');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessions.length, 2);
  assert.ok(Array.isArray(body.facets.agents));
});

test('过滤与搜索参数生效', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const byAgent = await (await fetch(s.base + '/api/sessions?agent=claude')).json();
  assert.equal(byAgent.sessions.length, 1);

  const byQuery = await (await fetch(s.base + '/api/sessions?q=构建失败')).json();
  assert.equal(byQuery.sessions.length, 1);
});

test('GET /api/session 返回详情，未知 key 404', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const ok = await fetch(s.base + '/api/session?key=' + encodeURIComponent('claude:a'));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).messages.length, 2);

  assert.equal((await fetch(s.base + '/api/session?key=nope')).status, 404);
});

test('GET /api/health 报告状态', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const h = await (await fetch(s.base + '/api/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.sessions, 2);
  assert.equal(h.scanning, false);
});

test('静态文件与路径穿越防护', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const root = await fetch(s.base + '/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.match(await root.text(), /id="app"/);

  assert.equal((await fetch(s.base + '/../package.json')).status, 404);
  assert.equal((await fetch(s.base + '/' + encodeURIComponent('../package.json'))).status, 404);
});
