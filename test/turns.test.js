import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, initSchema, replaceSession, pruneMissing, eventsSince,
  getTurn, getTurnMessages
} from '../src/db.js';
import { sessionId } from '../src/session-id.js';

const SYNC = { mtimeMs: 10, size: 100 };

function freshDb() {
  const db = openDb(':memory:');
  initSchema(db);
  return db;
}

function makeSession(overrides = {}) {
  return {
    key: 'claude:s1', agent: 'claude', nativeId: 's1', title: 'T',
    cwd: '/p/project', chatId: null, createdAt: 1, updatedAt: 2,
    sourcePath: '/p/s1.jsonl', archived: 0, messageCount: 3,
    tokens: null, extraJson: null, ...overrides
  };
}

const MESSAGES = [
  { role: 'user', at: 100, text: '问' },
  {
    role: 'assistant', at: 110, text: '中间',
    toolCalls: [{ id: 'c1', name: 'Bash', input: { cmd: 'ls' } }],
    toolResults: [{ callId: 'c1', output: 'a.txt' }]
  },
  { role: 'assistant', at: 120, text: '答' }
];

const TURNS = [{
  turnId: 't1', status: 'completed', signal: 'native',
  startedAt: 100, endedAt: 120, promptIndex: 0, finalIndex: 2
}];

function seed(db, overrides = {}, options = {}) {
  replaceSession(db, makeSession(overrides), MESSAGES, SYNC, {
    kind: 'created', turns: TURNS, ...options
  });
}

test('replaceSession writes turns and appends the session event before turn.completed', () => {
  const db = freshDb();
  seed(db);

  const turns = db.prepare('SELECT * FROM turns').all();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn_seq, 1);
  assert.equal(turns[0].turn_id, 't1');

  const events = eventsSince(db, { since: 0 }).events;
  assert.deepEqual(events.map(event => event.type), ['session.created', 'turn.completed']);

  assert.deepEqual(events[0].session, {
    key: 'claude:s1',
    id: events[0].session.id,
    agent: 'claude',
    project: 'project',
    cwd: '/p/project',
    title: 'T',
    messageCount: 3,
    updatedAt: 2,
    summary: '答',
    lastMessageSeq: 2,
    archived: false
  });

  assert.deepEqual(events[1].turn, {
    sessionKey: 'claude:s1',
    turnSeq: 1,
    turnId: 't1',
    status: 'completed',
    signal: 'native',
    startedAt: 100,
    endedAt: 120,
    promptSeq: 0,
    finalSeq: 2,
    prompt: { seq: 0, at: 100, role: 'user', text: '问' },
    final: { seq: 2, at: 120, role: 'assistant', text: '答' },
    summary: '答'
  });
  db.close();
});

test('re-parsing an unchanged session appends no second turn.completed', () => {
  const db = freshDb();
  seed(db);
  replaceSession(db, makeSession(), MESSAGES, SYNC, {
    kind: 'updated', turns: TURNS
  });

  const events = eventsSince(db, { since: 0 }).events;
  assert.deepEqual(events.map(event => event.type), ['session.created', 'turn.completed', 'session.updated']);
  assert.equal(db.prepare('SELECT count(*) c FROM turns').get().c, 1);
  db.close();
});

test('a status correction appends a higher seq with the same turnId', () => {
  const db = freshDb();
  seed(db);
  replaceSession(db, makeSession(), MESSAGES, SYNC, {
    kind: 'updated',
    turns: [{ ...TURNS[0], status: 'interrupted' }]
  });

  const events = eventsSince(db, { since: 0, types: ['turn.completed'] }).events;
  assert.equal(events.length, 2);
  assert.equal(events[0].turn.turnId, 't1');
  assert.equal(events[1].turn.turnId, 't1');
  assert.equal(events[1].turn.status, 'interrupted');
  assert.ok(events[1].seq > events[0].seq);
  db.close();
});

test('final is null when the turn ended without an assistant message', () => {
  const db = freshDb();
  seed(db, {}, {
    turns: [{
      turnId: 'err', status: 'error', signal: 'native',
      startedAt: 100, endedAt: 105, promptIndex: 0, finalIndex: null
    }]
  });

  const event = eventsSince(db, { since: 0, types: ['turn.completed'] }).events[0];
  assert.equal(event.turn.final, null);
  assert.equal(event.turn.summary, '');

  const detail = getTurn(db, 'claude:s1', 1);
  assert.deepEqual(detail.turn, event.turn);
  db.close();
});

test('turn text overrides win over the stored message text', () => {
  const db = freshDb();
  seed(db, {}, {
    turns: [{
      ...TURNS[0], finalText: '完整答案（跨多条记录）', promptText: '完整提问'
    }]
  });
  const event = eventsSince(db, { since: 0, types: ['turn.completed'] }).events[0];
  assert.equal(event.turn.prompt.text, '完整提问');
  assert.equal(event.turn.final.text, '完整答案（跨多条记录）');
  db.close();
});

test('getTurn returns the event turn object plus counts', () => {
  const db = freshDb();
  seed(db);
  const event = eventsSince(db, { since: 0, types: ['turn.completed'] }).events[0];

  const detail = getTurn(db, 'claude:s1', 1);
  assert.deepEqual(detail.turn, event.turn);
  assert.equal(detail.messageCount, 3);
  assert.equal(detail.toolCallCount, 1);
  assert.equal(detail.toolResultCount, 1);

  assert.equal(getTurn(db, 'claude:s1', 99), null);
  assert.equal(getTurn(db, 'nope', 1), null);
  db.close();
});

test('getTurnMessages pages the whole turn or only the middle', () => {
  const db = freshDb();
  seed(db);

  const whole = getTurnMessages(db, 'claude:s1', 1);
  assert.deepEqual(whole.turn, {
    sessionKey: 'claude:s1', turnSeq: 1, promptSeq: 0, finalSeq: 2
  });
  assert.deepEqual(whole.messages.map(message => message.seq), [0, 1, 2]);
  assert.deepEqual(whole.messages[1].toolCalls, [{ id: 'c1', name: 'Bash', input: { cmd: 'ls' } }]);
  assert.deepEqual(whole.messages[1].toolResults, [{ callId: 'c1', output: 'a.txt', isError: false }]);
  assert.equal(whole.hasMore, false);
  assert.equal(whole.nextAfter, 2);

  const middle = getTurnMessages(db, 'claude:s1', 1, { after: 0 });
  assert.deepEqual(middle.messages.map(message => message.seq), [1, 2]);
  assert.equal(middle.nextAfter, 2);

  const page = getTurnMessages(db, 'claude:s1', 1, { limit: 1 });
  assert.deepEqual(page.messages.map(message => message.seq), [0]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextAfter, 0);

  assert.equal(getTurnMessages(db, 'claude:s1', 9), null);
  db.close();
});

test('getTurnMessages respects maxBytes and never splits a single message', () => {
  const db = freshDb();
  replaceSession(db, makeSession(), [
    { role: 'user', at: 1, text: 'x'.repeat(2000) },
    { role: 'assistant', at: 2, text: 'y'.repeat(2000) }
  ], SYNC, {
    kind: 'created',
    turns: [{
      turnId: 't', status: 'completed', signal: 'native',
      startedAt: 1, endedAt: 2, promptIndex: 0, finalIndex: 1
    }]
  });

  const page = getTurnMessages(db, 'claude:s1', 1, { maxBytes: 100 });
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].text.length, 2000);
  assert.equal(page.hasMore, true);
  db.close();
});

test('pruneMissing appends a removal event in the same transaction when asked', () => {
  const db = freshDb();
  seed(db);
  const removed = pruneMissing(db, new Set(['/other']), { events: true });

  assert.equal(removed.length, 1);
  const event = eventsSince(db, { since: 0, types: ['session.removed'] }).events[0];
  assert.equal(event.session.key, 'claude:s1');
  assert.equal(event.session.agent, 'claude');
  assert.equal(event.session.id, sessionId('claude:s1'));
  assert.equal(db.prepare('SELECT count(*) c FROM turns').get().c, 0);
  db.close();
});
