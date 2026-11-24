import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

async function makeServer(extraSeed, extraFiles = {}, options = {}) {
  const db = openDb(':memory:');
  initSchema(db);
  seed(db);
  extraSeed?.(db);

  const publicDir = mkdtempSync(path.join(tmpdir(), 'session-hub-public-'));
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><div id="app"></div>');
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(path.join(publicDir, name), content);
  }

  const state = { scanning: false, lastSyncAt: null, warnings: [] };
  const config = {
    dbPath: '/tmp/session-hub-test/hub.db',
    roots: {
      claude: '/data/claude', codex: '/data/codex', dsh: '/data/dsh',
      workbuddy: '/data/workbuddy', larkChannel: '/data/lark'
    }
  };
  const server = createServer({
    db, state, publicDir, config,
    systemLanguage: options.systemLanguage ?? 'en-US'
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); }))
  };
}

function rawGet(hostname, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, headers }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function putJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
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

  const bySince = await (await fetch(s.base + '/api/sessions?since=250')).json();
  assert.equal(bySince.sessions.length, 1);
  assert.equal(bySince.sessions[0].key, 'claude:a');
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

test('GET /api/settings 返回设置、Agent 元数据与数据文件路径', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const body = await (await fetch(s.base + '/api/settings')).json();
  assert.deepEqual(body.settings, {
    showEmptySessions: false,
    showTempSessions: false,
    enabledAgents: ['claude', 'codex', 'dsh', 'workbuddy'],
    language: 'auto'
  });
  assert.deepEqual(
    body.agents.map(agent => agent.id),
    ['claude', 'codex', 'dsh', 'workbuddy']
  );
  assert.equal(body.dbPath, '/tmp/session-hub-test/hub.db');
  assert.equal(body.roots.workbuddy, '/data/workbuddy');
  assert.equal(body.systemLanguage, 'en-US');
});

test('PUT /api/settings 保存显示开关并立即影响列表、facets 与 health', async (t) => {
  const s = await makeServer((db) => {
    const base = { createdAt: 1, archived: 0, tokens: null, extraJson: null };
    replaceSession(db, {
      ...base, key: 'claude:empty', agent: 'claude', nativeId: 'empty', title: '空会话',
      cwd: '/p1', chatId: null, updatedAt: 900, sourcePath: '/x/empty.jsonl', messageCount: 0
    }, [], { mtimeMs: 900, size: 1 });
    replaceSession(db, {
      ...base, key: 'claude:tmp', agent: 'claude', nativeId: 'tmp', title: '临时会话',
      cwd: '/tmp', chatId: null, updatedAt: 800, sourcePath: '/x/tmp.jsonl', messageCount: 1
    }, [{ role: 'user', text: '临时' }], { mtimeMs: 800, size: 1 });
  });
  t.after(() => s.close());

  const empty = await putJson(s.base + '/api/settings', { showEmptySessions: true });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).settings.showEmptySessions, true);

  const withEmpty = await (await fetch(s.base + '/api/sessions')).json();
  assert.ok(withEmpty.sessions.some(session => session.key === 'claude:empty'));
  assert.equal(withEmpty.sessions.some(session => session.key === 'claude:tmp'), false);
  assert.equal((await (await fetch(s.base + '/api/health')).json()).sessions, 3);

  await putJson(s.base + '/api/settings', { showTempSessions: true });
  const withTemp = await (await fetch(s.base + '/api/sessions')).json();
  assert.ok(withTemp.sessions.some(session => session.key === 'claude:tmp'));
  assert.equal((await (await fetch(s.base + '/api/health')).json()).sessions, 4);
});

test('PUT /api/settings 可关闭 Agent，列表与 facets 立即过滤', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  await putJson(s.base + '/api/settings', { enabledAgents: ['claude'] });
  const filtered = await (await fetch(s.base + '/api/sessions')).json();
  assert.deepEqual(filtered.sessions.map(session => session.key), ['claude:a']);
  assert.deepEqual(filtered.facets.agents, [{ agent: 'claude', count: 1 }]);
  assert.equal((await (await fetch(s.base + '/api/health')).json()).sessions, 1);

  await putJson(s.base + '/api/settings', { enabledAgents: ['claude', 'codex'] });
  const restored = await (await fetch(s.base + '/api/sessions')).json();
  assert.deepEqual(restored.sessions.map(session => session.key), ['claude:a', 'codex:b']);
});

test('PUT /api/settings 拒绝非法 JSON、未知键与空 Agent 集合', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  assert.equal((await putJson(s.base + '/api/settings', '{bad json')).status, 400);
  assert.equal((await putJson(s.base + '/api/settings', { unknown: true })).status, 400);
  assert.equal((await putJson(s.base + '/api/settings', { enabledAgents: [] })).status, 400);
  assert.equal((await fetch(s.base + '/api/settings', { method: 'POST' })).status, 405);
  assert.equal((await fetch(s.base + '/api/sessions', { method: 'PUT' })).status, 405);
});

test('界面语言设置持久化，并影响 API 错误与警告语言', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const saved = await putJson(s.base + '/api/settings', { language: 'zh' });
  assert.equal((await saved.json()).settings.language, 'zh');
  assert.equal((await (await fetch(s.base + '/api/settings')).json()).settings.language, 'zh');

  const zhError = await (await fetch(s.base + '/api/session')).json();
  assert.equal(zhError.error, '缺少 key 参数');
  assert.equal(zhError.code, 'error.keyRequired');

  await putJson(s.base + '/api/settings', { language: 'en' });
  const enError = await (await fetch(s.base + '/api/session')).json();
  assert.equal(enError.error, 'Missing key parameter');
  assert.equal(enError.code, 'error.keyRequired');
});

test('未设置语言时跟随服务器系统语言，Accept-Language 不覆盖', async (t) => {
  const zhServer = await makeServer(undefined, {}, { systemLanguage: 'zh-CN' });
  t.after(() => zhServer.close());

  const zh = await (await fetch(zhServer.base + '/api/session', {
    headers: { 'accept-language': 'en-US,en;q=0.9' }
  })).json();
  assert.equal(zh.error, '缺少 key 参数');

  zhServer.state.warnings = [{ code: 'sourceRootUnavailable', params: { path: '/gone' } }];
  const zhHealth = await (await fetch(zhServer.base + '/api/health')).json();
  assert.deepEqual(zhHealth.warnings, ['来源根目录不可用：/gone']);

  const enServer = await makeServer(undefined, {}, { systemLanguage: 'en-US' });
  t.after(() => enServer.close());

  const en = await (await fetch(enServer.base + '/api/session', {
    headers: { 'accept-language': 'zh-CN,zh;q=0.9' }
  })).json();
  assert.equal(en.error, 'Missing key parameter');

  enServer.state.warnings = [{ code: 'sourceRootUnavailable', params: { path: '/gone' } }];
  const enHealth = await (await fetch(enServer.base + '/api/health')).json();
  assert.deepEqual(enHealth.warnings, ['Source root unavailable: /gone']);
});

test('非法设置返回翻译后的错误与稳定错误码', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  await putJson(s.base + '/api/settings', { language: 'zh' });
  const zh = await (await putJson(s.base + '/api/settings', { unknown: true })).json();
  assert.equal(zh.error, '未知设置项：unknown');
  assert.equal(zh.code, 'settings.error.unknownKey');

  await putJson(s.base + '/api/settings', { language: 'en' });
  const en = await (await putJson(s.base + '/api/settings', { language: 'fr' })).json();
  assert.equal(en.error, 'Setting language is invalid');
  assert.equal(en.code, 'settings.error.language');
});

test('默认隐藏空会话与临时目录，includeHidden=1 可包含', async (t) => {
  const s = await makeServer((db) => {
    const base = {
      createdAt: 1, archived: 0, tokens: null, extraJson: null
    };
    replaceSession(db, {
      ...base, key: 'claude:empty', agent: 'claude', nativeId: 'empty', title: '空会话',
      cwd: '/p1', chatId: null, updatedAt: 900, sourcePath: '/x/empty.jsonl', messageCount: 0
    }, [], { mtimeMs: 900, size: 1 });
    replaceSession(db, {
      ...base, key: 'claude:tmp', agent: 'claude', nativeId: 'tmp', title: '临时会话',
      cwd: '/tmp', chatId: null, updatedAt: 800, sourcePath: '/x/tmp.jsonl', messageCount: 1
    }, [{ role: 'user', text: '临时' }], { mtimeMs: 800, size: 1 });
  });
  t.after(() => s.close());

  const body = await (await fetch(s.base + '/api/sessions')).json();
  assert.deepEqual(body.sessions.map(x => x.key), ['claude:a', 'codex:b']);
  assert.equal(body.facets.agents.find(a => a.agent === 'claude').count, 1);

  const all = await (await fetch(s.base + '/api/sessions?includeHidden=1')).json();
  assert.equal(all.sessions.length, 4);
  assert.equal(all.facets.agents.find(a => a.agent === 'claude').count, 3);

  const health = await (await fetch(s.base + '/api/health')).json();
  assert.equal(health.sessions, 2);
});

test('拒绝非本机 Host 并附带安全响应头', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());
  const { hostname, port } = new URL(s.base);

  const evil = await rawGet(hostname, port, '/api/sessions', { Host: 'evil.example.com' });
  assert.equal(evil.status, 403);

  const ok = await rawGet(hostname, port, '/api/health', { Host: `127.0.0.1:${port}` });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
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

test('静态 PNG 以 image/png 返回', async (t) => {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const s = await makeServer(undefined, { 'logo.png': magic });
  t.after(() => s.close());

  const res = await fetch(s.base + '/logo.png');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/png/);
});
