import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, initSchema, appendEvent, eventsSince, getLastEventSeq, pruneEvents, clearAll
} from '../src/db.js';
import { sessionId } from '../src/session-id.js';

function freshDb() {
  const db = openDb(':memory:');
  initSchema(db);
  return db;
}

function append(db, type, extra = {}) {
  return appendEvent(db, {
    type,
    sessionKey: extra.sessionKey === undefined ? 'claude:a' : extra.sessionKey,
    agent: extra.agent === undefined ? 'claude' : extra.agent,
    cwd: extra.cwd === undefined ? '/p/a' : extra.cwd,
    at: extra.at ?? 1000,
    payload: extra.payload ?? {}
  });
}

test('appendEvent assigns increasing seq and eventsSince reads after the cursor', () => {
  const db = freshDb();
  const first = append(db, 'session.created');
  const second = append(db, 'session.updated');
  const third = append(db, 'sync.completed');

  assert.deepEqual([first, second, third], [1, 2, 3]);
  assert.equal(getLastEventSeq(db), 3);

  const all = eventsSince(db, { since: 0 });
  assert.equal(all.events.length, 3);
  assert.deepEqual(all.events[0], {
    v: 1, seq: 1, type: 'session.created', at: 1000
  });
  assert.equal(all.cursor, 3);
  assert.equal(all.hasMore, false);
  assert.equal(all.resync, false);

  const tail = eventsSince(db, { since: 2 });
  assert.deepEqual(tail.events.map(event => event.seq), [3]);
  assert.equal(tail.cursor, 3);
  db.close();
});

test('eventsSince merges the payload into the envelope', () => {
  const db = freshDb();
  append(db, 'session.updated', { payload: { session: { key: 'claude:a', summary: 'hi' } } });
  const [event] = eventsSince(db, { since: 0 }).events;
  assert.deepEqual(event.session, { key: 'claude:a', summary: 'hi' });
  assert.equal(event.v, 1);
  db.close();
});

test('eventsSince filters by agent and type', () => {
  const db = freshDb();
  append(db, 'session.created', { agent: 'claude' });
  append(db, 'session.created', { agent: 'codex' });
  append(db, 'session.updated', { agent: 'claude' });

  const codex = eventsSince(db, { since: 0, agents: ['codex'] });
  assert.deepEqual(codex.events.map(event => event.seq), [2]);

  const created = eventsSince(db, { since: 0, types: ['session.created'] });
  assert.deepEqual(created.events.map(event => event.seq), [1, 2]);

  const both = eventsSince(db, { since: 0, agents: ['claude'], types: ['session.updated'] });
  assert.deepEqual(both.events.map(event => event.seq), [3]);
  assert.equal(both.cursor, 3);
  db.close();
});

test('eventsSince pages with limit and reports hasMore', () => {
  const db = freshDb();
  for (let i = 0; i < 5; i += 1) append(db, 'sync.completed');
  const page = eventsSince(db, { since: 0, limit: 2 });
  assert.deepEqual(page.events.map(event => event.seq), [1, 2]);
  assert.equal(page.cursor, 2);
  assert.equal(page.hasMore, true);

  const last = eventsSince(db, { since: 4, limit: 2 });
  assert.deepEqual(last.events.map(event => event.seq), [5]);
  assert.equal(last.hasMore, false);
  db.close();
});

test('eventsSince caps the page by bytes and still returns one oversized event', () => {
  const db = freshDb();
  const big = 'x'.repeat(500);
  append(db, 'turn.completed', { payload: { text: big } });
  append(db, 'turn.completed', { payload: { text: big } });

  const page = eventsSince(db, { since: 0, maxBytes: 600 });
  assert.equal(page.events.length, 1);
  assert.equal(page.hasMore, true);

  const tiny = eventsSince(db, { since: 0, maxBytes: 1 });
  assert.equal(tiny.events.length, 1);
  assert.equal(tiny.hasMore, true);
  db.close();
});

test('eventsSince flags resync when since predates the oldest retained event', () => {
  const db = freshDb();
  for (let i = 0; i < 5; i += 1) append(db, 'sync.completed');
  pruneEvents(db, { maxRows: 2, maxAgeMs: 1e15 });

  const page = eventsSince(db, { since: 1 });
  assert.equal(page.resync, true);
  assert.deepEqual(page.events.map(event => event.seq), [4, 5]);
  assert.equal(page.cursor, 5);

  const oldest = eventsSince(db, { since: 0 });
  assert.equal(oldest.resync, false);
  assert.deepEqual(oldest.events.map(event => event.seq), [4, 5]);

  const future = eventsSince(db, { since: 99 });
  assert.equal(future.resync, true);
  assert.equal(future.events.length, 0);
  assert.equal(future.cursor, 5);
  db.close();
});

test('pruneEvents drops old events by age and keeps seq increasing', () => {
  const db = freshDb();
  append(db, 'session.created', { at: 1000 });
  append(db, 'session.created', { at: 5000 });
  const removed = pruneEvents(db, { maxAgeMs: 1000, now: 5500 });
  assert.equal(removed, 1);
  assert.deepEqual(eventsSince(db, { since: 0 }).events.map(event => event.seq), [2]);

  const next = append(db, 'session.updated');
  assert.equal(next, 3);
  assert.equal(getLastEventSeq(db), 3);
  db.close();
});

test('pruneEvents trims the byte budget from the oldest rows', () => {
  const db = freshDb();
  append(db, 'turn.completed', { payload: { text: 'a'.repeat(400) } });
  append(db, 'turn.completed', { payload: { text: 'b'.repeat(400) } });
  append(db, 'turn.completed', { payload: { text: 'c'.repeat(400) } });

  pruneEvents(db, { maxBytes: 600, maxAgeMs: 1e15 });
  const rows = eventsSince(db, { since: 0 }).events;
  assert.deepEqual(rows.map(event => event.seq), [3]);
  db.close();
});

test('clearAll clears the event log without rewinding the cursor', () => {
  const db = freshDb();
  append(db, 'sync.completed');
  append(db, 'sync.completed');
  clearAll(db);
  assert.deepEqual(eventsSince(db, { since: 0 }).events, []);
  assert.equal(getLastEventSeq(db), 2);
  assert.equal(append(db, 'sync.completed'), 3);
  db.close();
});

test('scope narrows the feed by agent, project, or internal session id', () => {
  const db = freshDb();
  append(db, 'session.updated', { sessionKey: 'claude:a', agent: 'claude', cwd: '/p/a' });
  append(db, 'session.updated', { sessionKey: 'codex:b', agent: 'codex', cwd: '/p/b' });
  append(db, 'turn.completed', { sessionKey: 'claude:a', agent: 'claude', cwd: '/p/a' });
  append(db, 'sync.completed', { sessionKey: null, agent: null, cwd: null });

  const byAgent = eventsSince(db, { since: 0, scope: { kind: 'agent', value: 'claude' } });
  assert.deepEqual(byAgent.events.map(event => event.seq), [1, 3]);

  const byProject = eventsSince(db, { since: 0, scope: { kind: 'project', value: '/p/b' } });
  assert.deepEqual(byProject.events.map(event => event.seq), [2]);

  const byId = eventsSince(db, {
    since: 0, scope: { kind: 'session', value: sessionId('claude:a') }
  });
  assert.deepEqual(byId.events.map(event => event.seq), [1, 3]);

  const byKey = eventsSince(db, { since: 0, scope: { kind: 'session', value: 'codex:b' } });
  assert.deepEqual(byKey.events.map(event => event.seq), [2]);

  const all = eventsSince(db, { since: 0 });
  assert.deepEqual(all.events.map(event => event.seq), [1, 2, 3, 4]);
  db.close();
});

test('scope combines with type and agent filters', () => {
  const db = freshDb();
  append(db, 'session.updated', { sessionKey: 'claude:a', agent: 'claude', cwd: '/p/a' });
  append(db, 'turn.completed', { sessionKey: 'claude:a', agent: 'claude', cwd: '/p/a' });
  append(db, 'turn.completed', { sessionKey: 'codex:b', agent: 'codex', cwd: '/p/b' });

  const scoped = eventsSince(db, {
    since: 0,
    types: ['turn.completed'],
    agents: ['claude'],
    scope: { kind: 'project', value: '/p/a' }
  });
  assert.deepEqual(scoped.events.map(event => event.seq), [2]);
  db.close();
});

test('initSchema adds scope columns to an existing event log and backfills them', () => {
  const db = openDb(':memory:');
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, session_key TEXT,
      agent TEXT, at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL,
      turn_seq INTEGER NOT NULL, turn_id TEXT, status TEXT NOT NULL, signal TEXT NOT NULL,
      started_at INTEGER, ended_at INTEGER, prompt_seq INTEGER, final_seq INTEGER,
      UNIQUE(session_key, turn_seq)
    );
  `);
  db.prepare(
    'INSERT INTO events (type, session_key, agent, at, payload) VALUES (?, ?, ?, ?, ?)'
  ).run('session.updated', 'claude:a', 'claude', 1000, '{}');

  initSchema(db);

  const columns = db.prepare('PRAGMA table_info(events)').all().map(column => column.name);
  assert.ok(columns.includes('session_id'));
  assert.ok(columns.includes('cwd'));
  const row = db.prepare('SELECT session_id AS sessionId FROM events').get();
  assert.equal(row.sessionId, sessionId('claude:a'));
  db.close();
});
