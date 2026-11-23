import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openDb, initSchema, replaceSession, getSyncState, hasSession, pruneMissing
} from '../src/db.js';

function makeSession(overrides = {}) {
  return {
    key: 'claude:s1', agent: 'claude', nativeId: 's1', title: 'T',
    cwd: '/p', chatId: null, createdAt: 1, updatedAt: 2, sourcePath: '/p/s1.jsonl',
    archived: 0, messageCount: 2, tokens: null, extraJson: null, ...overrides
  };
}

function freshDb() {
  const db = openDb(':memory:');
  initSchema(db);
  return db;
}

test('replaceSession 写入会话、消息、工具与 sync_state', () => {
  const db = freshDb();
  const messages = [
    { role: 'user', at: 1, text: 'hi' },
    {
      role: 'assistant', at: 2, text: 'yo', thinking: 'think',
      toolCalls: [{ id: 'c1', name: 'bash', input: { cmd: 'ls' } }],
      toolResults: [{ callId: 'c1', output: 'ok' }]
    }
  ];
  replaceSession(db, makeSession(), messages, { mtimeMs: 10, size: 100 });

  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM messages').get().c, 2);
  assert.equal(db.prepare('SELECT count(*) c FROM tool_calls').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM tool_results').get().c, 1);
  assert.deepEqual({ ...getSyncState(db, '/p/s1.jsonl') }, { mtimeMs: 10, size: 100 });
  assert.equal(hasSession(db, 'claude:s1'), true);
  assert.equal(hasSession(db, 'claude:nope'), false);
  db.close();
});

test('重新 replace 会替换旧消息且不留孤儿', () => {
  const db = freshDb();
  replaceSession(db, makeSession(), [
    { role: 'user', at: 1, text: 'hi' },
    {
      role: 'assistant', at: 2, text: 'yo',
      toolCalls: [{ id: 'c1', name: 'bash', input: {} }],
      toolResults: [{ callId: 'c1', output: 'ok' }]
    }
  ], { mtimeMs: 10, size: 100 });

  replaceSession(db, makeSession({ messageCount: 1 }), [
    { role: 'user', text: 'only' }
  ], { mtimeMs: 11, size: 50 });

  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM messages').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM tool_calls').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM tool_results').get().c, 0);
  assert.deepEqual({ ...getSyncState(db, '/p/s1.jsonl') }, { mtimeMs: 11, size: 50 });
  db.close();
});

test('pruneMissing 删除不在 keepPaths 的会话与 sync_state', () => {
  const db = freshDb();
  replaceSession(db, makeSession(), [{ role: 'user', text: 'hi' }], { mtimeMs: 10, size: 100 });

  assert.equal(pruneMissing(db, new Set(['/other'])), 1);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM sync_state').get().c, 0);
  db.close();
});

test('超大工具结果可入库并读回', () => {
  const db = freshDb();
  const big = 'x'.repeat(300 * 1024);
  replaceSession(db, makeSession({ messageCount: 1 }), [
    {
      role: 'assistant', text: 'a',
      toolCalls: [{ id: 'c1', name: 't', input: {} }],
      toolResults: [{ callId: 'c1', output: big }]
    }
  ], { mtimeMs: 1, size: 1 });

  const row = db.prepare('SELECT output FROM tool_results').get();
  assert.equal(row.output.length, big.length);
  db.close();
});

test('同 key 不同路径重写时清理旧路径的 sync_state', () => {
  const db = freshDb();
  replaceSession(db, makeSession({ sourcePath: '/p/a.jsonl' }), [{ role: 'user', text: 'a' }], { mtimeMs: 1, size: 1 });
  replaceSession(db, makeSession({ sourcePath: '/p/b.jsonl' }), [{ role: 'user', text: 'b' }], { mtimeMs: 2, size: 2 });

  assert.equal(getSyncState(db, '/p/a.jsonl'), null);
  assert.deepEqual({ ...getSyncState(db, '/p/b.jsonl') }, { mtimeMs: 2, size: 2 });
  assert.equal(db.prepare('SELECT source_path FROM sessions').get().source_path, '/p/b.jsonl');
  db.close();
});

test('自定义数据库路径不修改已存在目录权限，数据库文件 0600', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-perm-'));
  const dir = path.join(root, 'nested');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const dbPath = path.join(dir, 'hub.db');

  const db = openDb(dbPath);
  initSchema(db);

  assert.equal(statSync(dir).mode & 0o777, 0o755);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  db.close();
});
