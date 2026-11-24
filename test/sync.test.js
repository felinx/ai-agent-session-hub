import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, appendFileSync, utimesSync, unlinkSync, chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { openDb, initSchema, listSessions, eventsSince, getLastEventSeq } from '../src/db.js';
import { saveSettings } from '../src/settings.js';
import { syncOnce } from '../src/sync.js';
import { sessionId } from '../src/session-id.js';

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

function writeDsh(file, lines) {
  writeFileSync(
    file,
    zstdCompressSync(Buffer.from(lines.map(line => JSON.stringify(line)).join('\n')))
  );
}

test('first sync writes sessions from all four sources', async () => {
  const { db, config } = setup();
  const r = await syncOnce(db, config);
  assert.equal(r.added, 4);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 4);
});

test('change records carry the session id and the latest message summary', async () => {
  const { db, config } = setup();
  const r = await syncOnce(db, config);
  const dsh = r.changes.find(change => change.agent === 'dsh');
  assert.equal(dsh.kind, 'added');
  assert.equal(dsh.id, sessionId('dsh:session-33333333-3333-4333-8333-333333333333'));
  assert.equal(dsh.summary, '好的');
});

test('second sync with no changes reports everything as unchanged', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);
  const r = await syncOnce(db, config);
  assert.deepEqual(
    { added: r.added, updated: r.updated, unchanged: r.unchanged, removed: r.removed },
    { added: 0, updated: 0, unchanged: 4, removed: 0 }
  );
});

test('WorkBuddy sessions with legacy normalized cwd are reparsed and their original cwd restored', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);
  db.prepare('UPDATE sessions SET cwd = ? WHERE agent = ?')
    .run('workbuddy-default', 'workbuddy');

  await syncOnce(db, config);

  const row = db.prepare('SELECT cwd FROM sessions WHERE agent = ?').get('workbuddy');
  assert.equal(row.cwd, '/tmp/workbuddy');
});

test('appended content updates only the matching session', async () => {
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

test('deleting a source file prunes its session', async () => {
  const { db, config, files } = setup();
  await syncOnce(db, config);
  unlinkSync(files.codexFile);
  const r = await syncOnce(db, config);
  assert.equal(r.removed, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 3);
});

test('an unreadable source root produces a warning without deleting sessions', async () => {
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

test('title-only metadata changes also trigger an update', async () => {
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

test('catalog-only changes also refresh chatId', async () => {
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

test('nonexistent source roots still complete sync and produce warnings', async () => {
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

test('a missing source root does not delete existing sessions', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);

  const broken = { roots: { ...config.roots, claude: '/nonexistent/claude-root' } };
  const r = await syncOnce(db, broken);
  assert.equal(r.removed, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 4);
});

test('a bad file does not block other sessions and preserves old data', async () => {
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

test('disabling an agent stops syncing and prunes its sessions, and re-enabling restores them', async () => {
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

test('chatId is null when the catalog is missing', async () => {
  const { db, config } = setup();
  await syncOnce(db, config);
  assert.ok(listSessions(db, {}).every(s => s.chatId === null));
});

test('sync appends created events and one sync.completed per pass', async () => {
  const { db, config } = setup();
  const r = await syncOnce(db, config);
  const events = eventsSince(db, { since: 0 }).events;
  assert.deepEqual(events.map(event => event.type), [
    'session.created', 'session.created', 'session.created', 'session.created', 'sync.completed'
  ]);
  assert.deepEqual(events.at(-1).added, 4);
  assert.deepEqual(events.at(-1).updated, 0);
  assert.deepEqual(events.at(-1).removed, 0);
  assert.equal(r.added, 4);
  db.close();
});

test('change records carry the key, project, updatedAt, and lastMessageSeq', async () => {
  const { db, config } = setup();
  const r = await syncOnce(db, config);
  const claude = r.changes.find(change => change.agent === 'claude');
  assert.equal(claude.key, `claude:${CLAUDE_ID}`);
  assert.equal(claude.project, 'proj');
  assert.equal(claude.lastMessageSeq, 1);
  assert.ok(claude.updatedAt > 0);
  db.close();
});

test('an appended completed turn emits session.updated, turn.completed, then sync.completed', async () => {
  const { db, config, files } = setup();
  await syncOnce(db, config);
  const head = getLastEventSeq(db);

  writeDsh(files.dshFile, [
    ...DSH_LINES,
    { type: 'turn/start', time: 1795000003000, data: { turn: 2 } },
    {
      type: 'user/message', seq: 3, time: 1795000003000,
      data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '第二问' }] }
    },
    {
      type: 'assistant/message', seq: 4, time: 1795000004000,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '第二答' }] } }
    },
    { type: 'turn/end', time: 1795000005000, data: { turn: 2, reason: { kind: 'completed' } } }
  ]);
  bumpMtime(files.dshFile);

  await syncOnce(db, config);
  const events = eventsSince(db, { since: head }).events;
  assert.deepEqual(events.map(event => event.type), [
    'session.updated', 'turn.completed', 'sync.completed'
  ]);
  assert.equal(events[1].turn.prompt.text, '第二问');
  assert.equal(events[1].turn.final.text, '第二答');
  assert.equal(events[1].turn.status, 'completed');
  db.close();
});

test('a prompt with no answer after settling is emitted as an interrupted turn', async () => {
  const { db, config, files } = setup();
  await syncOnce(db, config);
  const head = getLastEventSeq(db);

  writeDsh(files.dshFile, [
    ...DSH_LINES,
    { type: 'turn/start', time: 1795000006000, data: { turn: 3 } },
    {
      type: 'user/message', seq: 5, time: 1795000006000,
      data: { id: 'u3', role: 'user', content: [{ type: 'text', text: '没有回答就断了' }] }
    }
  ]);
  const old = new Date(Date.now() - 60_000);
  utimesSync(files.dshFile, old, old);

  await syncOnce(db, config);
  const turn = eventsSince(db, { since: head, types: ['turn.completed'] }).events[0];
  assert.equal(turn.turn.status, 'interrupted');
  assert.equal(turn.turn.prompt.text, '没有回答就断了');
  assert.equal(turn.turn.final, null);
  db.close();
});

test('deleting a source file appends session.removed before sync.completed', async () => {
  const { db, config, files } = setup();
  await syncOnce(db, config);
  const head = getLastEventSeq(db);

  unlinkSync(files.codexFile);
  await syncOnce(db, config);
  const events = eventsSince(db, { since: head }).events;
  assert.deepEqual(events.map(event => event.type), ['session.removed', 'sync.completed']);
  assert.equal(events[0].session.agent, 'codex');
  assert.equal(events[1].removed, 1);
  db.close();
});

test('a settle re-parse adds no duplicate session or turn events', async () => {
  const { db, config, files } = setup();
  const old = new Date(Date.now() - 60_000);
  utimesSync(files.claudeFile, old, old);

  await syncOnce(db, config);
  const head = getLastEventSeq(db);

  // Pretend the last parse happened before the settle point: the next pass re-parses
  // the unchanged file once to allow inferred turn completions.
  db.prepare('UPDATE sync_state SET last_synced_at = 0 WHERE source_path = ?')
    .run(files.claudeFile);

  const r = await syncOnce(db, config);
  assert.equal(r.unchanged, 4);
  const events = eventsSince(db, { since: head }).events;
  assert.deepEqual(events.map(event => event.type), ['sync.completed']);
  db.close();
});
