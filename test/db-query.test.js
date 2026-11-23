import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, initSchema, replaceSession } from '../src/db.js';
import { listSessions, getSession, getFacets } from '../src/db.js';

function session(key, agent, nativeId, chatId, cwd, updatedAt) {
  return {
    key, agent, nativeId, title: `title-${nativeId}`, cwd, chatId,
    createdAt: 1, updatedAt, sourcePath: `${cwd}/${agent}-${nativeId}.jsonl`,
    archived: 0, messageCount: 2, tokens: null, extraJson: null
  };
}

function seed(db) {
  replaceSession(db, session('claude:a', 'claude', 'a', 'oc_A', '/p1', 300), [
    { role: 'user', text: '这个项目为什么构建失败' },
    {
      role: 'assistant', text: '我看一下',
      toolCalls: [{ id: 'c1', name: 'bash', input: { cmd: 'ls' } }],
      toolResults: [{ callId: 'c1', output: 'ok' }]
    }
  ], { mtimeMs: 300, size: 1 });

  replaceSession(db, session('codex:b', 'codex', 'b', 'oc_B', '/p2', 200), [
    { role: 'user', text: '会话聚合' },
    { role: 'assistant', text: '好的' }
  ], { mtimeMs: 200, size: 1 });

  replaceSession(db, session('dsh:c', 'dsh', 'c', null, '/p1', 100), [
    { role: 'user', text: '扩展这个库' }
  ], { mtimeMs: 100, size: 1 });
}

function freshDb() {
  const db = openDb(':memory:');
  initSchema(db);
  seed(db);
  return db;
}

test('listSessions 过滤、排序与 limit', () => {
  const db = freshDb();
  assert.deepEqual(listSessions(db, {}).map(s => s.key), ['claude:a', 'codex:b', 'dsh:c']);
  assert.deepEqual(listSessions(db, { agent: 'codex' }).map(s => s.key), ['codex:b']);
  assert.deepEqual(listSessions(db, { chat: 'oc_A' }).map(s => s.key), ['claude:a']);
  assert.deepEqual(listSessions(db, { cwd: '/p1' }).map(s => s.key), ['claude:a', 'dsh:c']);
  assert.equal(listSessions(db, { limit: 2 }).length, 2);
  assert.equal(listSessions(db, { q: '构建失败' }).length, 1);
  assert.deepEqual(listSessions(db, { q: '构建失败' }).map(s => s.key), ['claude:a']);
  assert.deepEqual(listSessions(db, { q: '会话' }).map(s => s.key), ['codex:b']);
  db.close();
});

test('getSession 组装消息、工具与 archived 布尔值', () => {
  const db = freshDb();
  const detail = getSession(db, 'claude:a');
  assert.equal(detail.session.key, 'claude:a');
  assert.equal(detail.session.archived, false);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].text, '这个项目为什么构建失败');
  assert.equal(detail.messages[1].toolCalls[0].name, 'bash');
  assert.deepEqual(detail.messages[1].toolCalls[0].input, { cmd: 'ls' });
  assert.equal(detail.messages[1].toolResults[0].output, 'ok');
  assert.equal(getSession(db, 'nope'), null);
  db.close();
});

test('getFacets 统计三个维度', () => {
  const db = freshDb();
  const facets = getFacets(db);
  assert.deepEqual(facets.agents.map(a => a.agent).sort(), ['claude', 'codex', 'dsh']);
  assert.deepEqual(facets.chats.map(c => c.chatId).sort(), ['oc_A', 'oc_B']);
  const p1 = facets.cwds.find(c => c.cwd === '/p1');
  assert.equal(p1.count, 2);
  db.close();
});
