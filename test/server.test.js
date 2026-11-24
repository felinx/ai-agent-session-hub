import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
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
    publicDir,
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

test('GET /api/sessions returns the list and facets', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const res = await fetch(s.base + '/api/sessions');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessions.length, 2);
  assert.ok(Array.isArray(body.facets.agents));
});

test('filter and search parameters take effect', async (t) => {
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

test('GET /api/session returns details and 404 for an unknown key', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const ok = await fetch(s.base + '/api/session?key=' + encodeURIComponent('claude:a'));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).messages.length, 2);

  assert.equal((await fetch(s.base + '/api/session?key=nope')).status, 404);
});

test('GET /api/health reports status', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const h = await (await fetch(s.base + '/api/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.sessions, 2);
  assert.equal(h.scanning, false);
});

test('GET /api/settings returns settings, agent metadata, and data file paths', async (t) => {
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

test('PUT /api/settings saves display toggles and immediately affects the list, facets, and health', async (t) => {
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

test('PUT /api/settings can disable agents and immediately filters the list and facets', async (t) => {
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

test('PUT /api/settings rejects invalid JSON, unknown keys, and an empty agent set', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  assert.equal((await putJson(s.base + '/api/settings', '{bad json')).status, 400);
  assert.equal((await putJson(s.base + '/api/settings', { unknown: true })).status, 400);
  assert.equal((await putJson(s.base + '/api/settings', { enabledAgents: [] })).status, 400);
  assert.equal((await fetch(s.base + '/api/settings', { method: 'POST' })).status, 405);
  assert.equal((await fetch(s.base + '/api/sessions', { method: 'PUT' })).status, 405);
});

test('UI language setting persists and affects the language of API errors and warnings', async (t) => {
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

test('language follows the server system language when unset, and Accept-Language does not override it', async (t) => {
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

test('invalid settings return translated errors and stable error codes', async (t) => {
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

test('empty sessions and temp directories are hidden by default, and includeHidden=1 includes them', async (t) => {
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

test('rejects non-local Host headers and includes security response headers', async (t) => {
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

test('static file serving and path traversal protection', async (t) => {
  const s = await makeServer();
  t.after(() => s.close());

  const root = await fetch(s.base + '/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.match(await root.text(), /id="app"/);

  assert.equal((await fetch(s.base + '/../package.json')).status, 404);
  assert.equal((await fetch(s.base + '/' + encodeURIComponent('../package.json'))).status, 404);
});

test('static PNG is returned as image/png', async (t) => {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const s = await makeServer(undefined, { 'logo.png': magic });
  t.after(() => s.close());

  const res = await fetch(s.base + '/logo.png');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/png/);
});

function seedSessionWithCwd(db, key, cwd) {
  replaceSession(db, {
    createdAt: 1, archived: 0, messageCount: 0, tokens: null, extraJson: null,
    key, agent: 'claude', nativeId: key.split(':')[1], title: 'asset',
    cwd, chatId: null, updatedAt: 1, sourcePath: `/x/${key}.jsonl`
  }, [], { mtimeMs: 1, size: 1 });
}

test('GET /api/session/asset only returns images inside the session directory', async (t) => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-asset-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'sh-asset-out-'));
  mkdirSync(path.join(dir, 'shots'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  writeFileSync(path.join(dir, 'shots', 'pixel.png'), png);
  writeFileSync(path.join(dir, 'notes.txt'), 'text');
  writeFileSync(path.join(outside, 'secret.png'), png);
  try {
    symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'link.png'));
  } catch {}

  const s = await makeServer(db => seedSessionWithCwd(db, 'claude:img', dir));
  t.after(() => s.close());

  const ok = await fetch(s.base + '/api/session/asset?key=' + encodeURIComponent('claude:img')
    + '&path=' + encodeURIComponent('shots/pixel.png'));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);

  const absoluteInside = await fetch(s.base + '/api/session/asset?key=claude%3Aimg&path='
    + encodeURIComponent(path.join(dir, 'shots', 'pixel.png')));
  assert.equal(absoluteInside.status, 200);

  for (const bad of [
    'shots/gone.png',
    'notes.txt',
    path.relative(dir, outside) + '/secret.png',
    path.join(outside, 'secret.png')
  ]) {
    const res = await fetch(s.base + '/api/session/asset?key=claude%3Aimg&path=' + encodeURIComponent(bad));
    assert.equal(res.status, 404, `${bad} 应被拒绝`);
  }

  const symlink = await fetch(s.base + '/api/session/asset?key=claude%3Aimg&path=link.png');
  assert.equal(symlink.status, 404);

  assert.equal((await fetch(s.base + '/api/session/asset?key=claude%3Aimg')).status, 400);
  assert.equal((await fetch(s.base + '/api/session/asset?path=a.png')).status, 400);
  assert.equal((await fetch(s.base + '/api/session/asset?key=nope&path=a.png')).status, 404);
});

test('static assets referenced by the index page automatically get content version hashes', async (t) => {
  const s = await makeServer(undefined, {
    'index.html': '<!doctype html>'
      + '<link rel="stylesheet" href="/style.css">'
      + '<link rel="icon" href="/favicon.svg">'
      + '<script type="module" src="/app.js"></script>'
      + '<img src="/logo.svg">'
      + '<img src="/missing.png">',
    'style.css': 'body{color:red}',
    'app.js': 'console.log(1)',
    'logo.svg': '<svg/>',
    'favicon.svg': '<svg/>'
  });
  t.after(() => s.close());

  const html = await (await fetch(s.base + '/')).text();
  assert.match(html, /href="\/style\.css\?v=[0-9a-f]{10}"/);
  assert.match(html, /href="\/favicon\.svg\?v=[0-9a-f]{10}"/);
  assert.match(html, /src="\/app\.js\?v=[0-9a-f]{10}"/);
  assert.match(html, /src="\/logo\.svg\?v=[0-9a-f]{10}"/);
  assert.match(html, /src="\/missing\.png"/);

  const css = await fetch(s.base + '/style.css?v=whatever');
  assert.equal(css.status, 200);
  assert.equal(await css.text(), 'body{color:red}');
});

test('static asset version hashes change when file content changes', async (t) => {
  const s = await makeServer(undefined, {
    'index.html': '<link rel="stylesheet" href="/style.css">',
    'style.css': 'body{color:red}'
  });
  t.after(() => s.close());

  const versionOf = async () => {
    const html = await (await fetch(s.base + '/')).text();
    return html.match(/style\.css\?v=([0-9a-f]+)/)?.[1];
  };

  const before = await versionOf();
  assert.ok(before);
  writeFileSync(path.join(s.publicDir, 'style.css'), 'body{color:blue;padding:0}');
  assert.notEqual(await versionOf(), before);
});

test('GET /api/file returns local file contents read-only', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sh-file-'));
  const textFile = path.join(dir, 'notes.md');
  writeFileSync(textFile, 'line1\nline2\n');
  const binaryFile = path.join(dir, 'blob.bin');
  writeFileSync(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0x00]));
  const bigFile = path.join(dir, 'big.txt');
  writeFileSync(bigFile, 'a'.repeat(1024 * 1024 + 10));

  const s = await makeServer(db => seedSessionWithCwd(db, 'claude:files', dir));
  t.after(() => s.close());

  const absolute = await (await fetch(s.base + '/api/file?path=' + encodeURIComponent(textFile))).json();
  assert.equal(absolute.content, 'line1\nline2\n');
  assert.equal(absolute.binary, false);
  assert.equal(absolute.truncated, false);
  assert.equal(absolute.path, realpathSync(textFile));
  assert.equal(absolute.name, 'notes.md');

  const relative = await (await fetch(s.base + '/api/file?path=notes.md&session=claude%3Afiles')).json();
  assert.equal(relative.content, 'line1\nline2\n');

  assert.equal((await fetch(s.base + '/api/file?path=notes.md')).status, 400);
  assert.equal((await fetch(s.base + '/api/file?path=missing.md&session=claude%3Afiles')).status, 404);
  assert.equal((await fetch(s.base + '/api/file?path=' + encodeURIComponent(dir))).status, 404);
  assert.equal((await fetch(s.base + '/api/file')).status, 400);

  const binary = await (await fetch(s.base + '/api/file?path=' + encodeURIComponent(binaryFile))).json();
  assert.equal(binary.binary, true);
  assert.equal(binary.content, '');

  const big = await (await fetch(s.base + '/api/file?path=' + encodeURIComponent(bigFile))).json();
  assert.equal(big.truncated, true);
  assert.equal(big.content.length, 1024 * 1024);
});

test('GET /api/status reports scan state and per-agent statistics', async (t) => {
  const s = await makeServer();
  s.state.lastSyncAt = 1234;
  t.after(() => s.close());

  const res = await fetch(s.base + '/api/status');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.scanning, false);
  assert.equal(body.lastSyncAt, 1234);
  assert.deepEqual(body.totals, { sessions: 2, messages: 4 });

  const claude = body.agents.find(row => row.agent === 'claude');
  assert.equal(claude.sessions, 1);
  assert.equal(claude.messages, 2);
  assert.equal(claude.lastSyncAt, 300);
  assert.equal(claude.latest.key, 'claude:a');
  assert.match(claude.latest.id, /^[0-9a-f]{8}$/);
  assert.equal(claude.latest.summary, '我看一下');
});
