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

test('replaceSession writes the session, messages, tools, and sync_state', () => {
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

test('replacing again swaps old messages without leaving orphans', () => {
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

test('pruneMissing deletes sessions and sync_state not in keepPaths and returns summaries of deleted sessions', () => {
  const db = freshDb();
  replaceSession(db, makeSession(), [{ role: 'user', text: 'hi' }], { mtimeMs: 10, size: 100 });

  const removed = pruneMissing(db, new Set(['/other']));
  assert.equal(removed.length, 1);
  assert.equal(removed[0].key, makeSession().key);
  assert.equal(removed[0].agent, makeSession().agent);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM sync_state').get().c, 0);
  db.close();
});

test('very large tool results can be stored and read back', () => {
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

test('rewriting the same key with a different path clears sync_state for the old path', () => {
  const db = freshDb();
  replaceSession(db, makeSession({ sourcePath: '/p/a.jsonl' }), [{ role: 'user', text: 'a' }], { mtimeMs: 1, size: 1 });
  replaceSession(db, makeSession({ sourcePath: '/p/b.jsonl' }), [{ role: 'user', text: 'b' }], { mtimeMs: 2, size: 2 });

  assert.equal(getSyncState(db, '/p/a.jsonl'), null);
  assert.deepEqual({ ...getSyncState(db, '/p/b.jsonl') }, { mtimeMs: 2, size: 2 });
  assert.equal(db.prepare('SELECT source_path FROM sessions').get().source_path, '/p/b.jsonl');
  db.close();
});

test('custom database path leaves existing directory permissions unchanged and creates the database file with mode 0600', () => {
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
