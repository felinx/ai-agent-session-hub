import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, appendFileSync, utimesSync, unlinkSync, chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { openDb, initSchema, listSessions } from '../src/db.js';
import { saveSettings } from '../src/settings.js';
import { syncOnce } from '../src/sync.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';
const WORKBUDDY_ID = '44444444-4444-4444-8444-444444444444';
const DSH_LINES = [
  { type: 'session', version: 4, id: 'session-33333333-3333-4333-8333-333333333333', createdAt: 1795000000000, cwd: '/tmp/dsh' },
  { type: 'user/message', seq: 1, time: 1795000001000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '扩展这个库' }] } },
  { type: 'assistant/message', seq: 2, time: 1795000002000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } }
];

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-sync-'));
  const claudeRoot = path.join(root, 'claude');
  const codexRoot = path.join(root, 'codex');
  const dshRoot = path.join(root, 'dsh');
  const workbuddyRoot = path.join(root, 'workbuddy');

  const claudeFile = path.join(claudeRoot, 'projects', 'p1', `${CLAUDE_ID}.jsonl`);
  mkdirSync(path.dirname(claudeFile), { recursive: true });
  copyFileSync(path.join(FIXTURES, 'claude', 'session-1.jsonl'), claudeFile);

  const codexFile = path.join(codexRoot, 'sessions', '2026', '11', '01', 'rollout-1.jsonl');
  mkdirSync(path.dirname(codexFile), { recursive: true });
  copyFileSync(path.join(FIXTURES, 'codex', 'rollout-1.jsonl'), codexFile);

  const dshFile = path.join(
    dshRoot, 'sessions', 'slug', 'session-33333333-3333-4333-8333-333333333333', 'session.v4.jsonl.zstd'
  );
  mkdirSync(path.dirname(dshFile), { recursive: true });
  writeFileSync(dshFile, zstdCompressSync(Buffer.from(DSH_LINES.map(l => JSON.stringify(l)).join('\n'))));

  const workbuddyFile = path.join(
    workbuddyRoot, 'projects', 'Users-felinx-WorkBuddy-misc', `${WORKBUDDY_ID}.jsonl`
  );
  mkdirSync(path.dirname(workbuddyFile), { recursive: true });
  copyFileSync(path.join(FIXTURES, 'workbuddy', 'session-1.jsonl'), workbuddyFile);

  const config = {
    roots: {
      claude: claudeRoot,
      codex: codexRoot,
      dsh: dshRoot,
      workbuddy: workbuddyRoot,
      larkChannel: path.join(root, 'lark')
    }
  };

  const db = openDb(':memory:');
  initSchema(db);
  return { root, config, db, files: { claudeFile, codexFile, dshFile, workbuddyFile } };
}

function bumpMtime(file) {
  const next = new Date(Date.now() + 10_000);
  utimesSync(file, next, next);
}

test('首次同步写入四源会话', async () => {
  const { db, config } = setup();
  const r = await syncOnce(db, config);
  assert.equal(r.added, 4);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 4);
});

test('二次同步未变化时全部 unchanged', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);
  const r = await syncOnce(db, config);
  assert.deepEqual(
    { added: r.added, updated: r.updated, unchanged: r.unchanged, removed: r.removed },
    { added: 0, updated: 0, unchanged: 4, removed: 0 }
  );
});

test('旧版本归一的 WorkBuddy 会话会重新解析并恢复原始 cwd', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);
  db.prepare('UPDATE sessions SET cwd = ? WHERE agent = ?')
    .run('workbuddy-default', 'workbuddy');

  await syncOnce(db, config);

  const row = db.prepare('SELECT cwd FROM sessions WHERE agent = ?').get('workbuddy');
  assert.equal(row.cwd, '/tmp/workbuddy');
});

test('追加内容只更新对应会话', async () => {
  const { db, config, files } = setup();
  await syncOnce(db, config);

  appendFileSync(files.claudeFile, JSON.stringify({
    type: 'user', sessionId: CLAUDE_ID, timestamp: '2026-11-01T00:00:09.000Z',
    message: { role: 'user', content: '再追加一条' }
  }) + '\n');
  bumpMtime(files.claudeFile);

  const r = await syncOnce(db, config);
  assert.equal(r.updated, 1);
  assert.equal(r.unchanged, 3);
  const row = db.prepare('SELECT message_count FROM sessions WHERE key = ?').get(`claude:${CLAUDE_ID}`);
  assert.equal(row.message_count, 3);
});

test('删除源文件后清理会话', async () => {
  const { db, config, files } = setup();
  await syncOnce(db, config);
  unlinkSync(files.codexFile);
  const r = await syncOnce(db, config);
  assert.equal(r.removed, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 3);
});

test('源根目录不可读时产生 warning 且不误删', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);

  const projectsDir = path.join(config.roots.claude, 'projects');
  chmodSync(projectsDir, 0o000);
  try {
    const r = await syncOnce(db, config);
    assert.ok(r.warnings.length > 0);
    assert.ok(r.warnings.every(w => w && typeof w.code === 'string'));
    assert.equal(r.removed, 0);
    assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 4);
  } finally {
    chmodSync(projectsDir, 0o755);
  }
});

test('仅标题元数据变化也会刷新', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);

  const titlePath = path.join(config.roots.claude, 'projects', 'p1', CLAUDE_ID, 'custom-title.json');
  mkdirSync(path.dirname(titlePath), { recursive: true });
  writeFileSync(titlePath, JSON.stringify({ customTitle: '新标题' }));

  const r = await syncOnce(db, config);
  assert.equal(r.updated, 1);
  const row = db.prepare('SELECT title FROM sessions WHERE key = ?').get(`claude:${CLAUDE_ID}`);
  assert.equal(row.title, '新标题');
});

test('仅 catalog 变化也会刷新 chatId', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);

  const profileDir = path.join(config.roots.larkChannel, 'profiles', 'claude');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, 'sessions.json.catalog.json'),
    JSON.stringify([{ scopeId: 'oc_NEW', agentId: 'claude', sessionId: CLAUDE_ID }])
  );

  const r = await syncOnce(db, config);
  assert.equal(r.updated, 1);
  const row = db.prepare('SELECT chat_id FROM sessions WHERE key = ?').get(`claude:${CLAUDE_ID}`);
  assert.equal(row.chat_id, 'oc_NEW');
});

test('源根目录不存在时仍完成并产生 warning', async () => {
  const { db } = setup();
  const config = {
    roots: {
      claude: '/nonexistent/claude-root',
      codex: '/nonexistent/codex-root',
      dsh: '/nonexistent/dsh-root',
      workbuddy: '/nonexistent/workbuddy-root',
      larkChannel: '/nonexistent/lark-root'
    }
  };
  const r = await syncOnce(db, config);
  assert.ok(r.warnings.some(w => w.code === 'sourceRootUnavailable' && String(w.params?.path).includes('/nonexistent/')));
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 0);
});

test('源根目录缺失时不会误删已有会话', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);

  const broken = { roots: { ...config.roots, claude: '/nonexistent/claude-root' } };
  const r = await syncOnce(db, broken);
  assert.equal(r.removed, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 4);
});

test('坏文件不阻塞其它会话且保留旧数据', async () => {
  const { db, config, files } = setup();
  await syncOnce(db, config);

  writeFileSync(files.dshFile, Buffer.from('garbage'));
  bumpMtime(files.dshFile);

  const r = await syncOnce(db, config);
  assert.ok(r.warnings.some(w => w.code === 'parseFailed' && w.params?.path === files.dshFile));
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 4);
  const row = db.prepare('SELECT message_count, title FROM sessions WHERE agent = ?').get('dsh');
  assert.equal(row.message_count, 2);
  assert.equal(row.title, '扩展这个库');
});

test('关闭 Agent 后停止同步并清理其会话，重新开启可恢复', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 4);

  saveSettings(db, { enabledAgents: ['claude', 'workbuddy'] });
  const r = await syncOnce(db, config);
  assert.equal(r.removed, 2);
  assert.deepEqual(
    [...new Set(listSessions(db, { includeHidden: true }).map(session => session.agent))].sort(),
    ['claude', 'workbuddy']
  );

  saveSettings(db, { enabledAgents: ['claude', 'codex', 'dsh', 'workbuddy'] });
  const restored = await syncOnce(db, config);
  assert.equal(restored.added, 2);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 4);
});

test('catalog 缺失时 chatId 为 null', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);
  assert.ok(listSessions(db, {}).every(s => s.chatId === null));
});
