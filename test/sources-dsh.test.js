import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { discoverDsh, parseDsh } from '../src/sources/dsh.js';

const SESSION_FILE = 'session.v4.jsonl.zstd';

function writeSession(root, slug, dirName, lines) {
  const dir = path.join(root, 'sessions', slug, dirName);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SESSION_FILE);
  writeFileSync(file, zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n'))));
  return file;
}

const LINES = [
  { type: 'session', version: 4, id: 'session-33333333-3333-4333-8333-333333333333', createdAt: 1795000000000, cwd: '/tmp/dsh' },
  { type: 'user/message', seq: 1, time: 1795000001000, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '扩展这个库' }] } },
  { type: 'session/title', seq: 2, data: { title: '扩展这个库' } },
  {
    type: 'assistant/message', seq: 3, time: 1795000002000,
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '先读文档' }, { type: 'text', text: '我读一下' }] } }
  },
  { type: 'tool/call', seq: 4, data: { callId: 'tool-1', name: 'read', arguments: '{"path":"README.md"}' } },
  { type: 'tool/result', seq: 5, data: { toolCallId: 'tool-1', content: [{ type: 'text', text: '# README' }], isError: false } },
  { type: 'turn/end', seq: 6, data: {} }
];

test('parseDsh extracts metadata, title, messages, and tools', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-dsh-'));
  const file = writeSession(root, 'slug', 'session-33333333-3333-4333-8333-333333333333', LINES);

  const p = await parseDsh(file);
  assert.equal(p.nativeId, 'session-33333333-3333-4333-8333-333333333333');
  assert.equal(p.cwd, '/tmp/dsh');
  assert.equal(p.title, '扩展这个库');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[1].thinking, '先读文档');
  assert.deepEqual(p.messages[1].toolCalls[0], { id: 'tool-1', name: 'read', input: { path: 'README.md' } });
  assert.deepEqual(p.messages[1].toolResults[0], { callId: 'tool-1', output: '# README', isError: false });
});

test('parseDsh skips harness context messages', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-dsh-'));
  const file = writeSession(root, 'slug', 'session-context', [
    { type: 'session', id: 'session-context', createdAt: 1, cwd: '/tmp/dsh' },
    { type: 'user/message', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '真实问题' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '运行时上下文' }], source: { kind: 'runtime-context' } } },
    { type: 'user/message', data: { id: 'u3', role: 'user', content: [{ type: 'text', text: '技能目录' }], source: { kind: 'skill-catalog' } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } } }
  ]);

  const p = await parseDsh(file);
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[0].text, '真实问题');
});

test('discoverDsh finds zstd sessions and extracts chatId from directory names', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-dsh-'));
  writeSession(root, 'slug', 'session-33333333-3333-4333-8333-333333333333', LINES);
  writeSession(root, 'lark', 'lark-oc_ABC--hash', LINES);

  const files = await discoverDsh({ roots: { dsh: root } });
  assert.equal(files.length, 2);
  const lark = files.find(f => f.nativeId === 'lark-oc_ABC--hash');
  assert.equal(lark.chatHint, 'oc_ABC');
});

test('missing projcache and corrupt compressed files do not affect other sessions', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-dsh-'));
  writeSession(root, 'slug', 'session-33333333-3333-4333-8333-333333333333', LINES);
  const badDir = path.join(root, 'sessions', 'slug', 'broken');
  mkdirSync(badDir, { recursive: true });
  const bad = path.join(badDir, SESSION_FILE);
  writeFileSync(bad, Buffer.from('not a zstd frame'));

  const files = await discoverDsh({ roots: { dsh: root } });
  assert.equal(files.length, 2);
  await assert.rejects(parseDsh(bad));
});

const T0 = 1795000000000;

function turnLines(reasonKind = 'completed', n = 1) {
  return [
    { type: 'turn/start', seq: n * 10, time: T0 + n * 1000, data: { turn: n } },
    {
      type: 'user/message', seq: n * 10 + 1, time: T0 + n * 1000 + 100,
      data: { id: `u${n}`, role: 'user', content: [{ type: 'text', text: `问题${n}` }], source: { kind: 'user' } }
    },
    {
      type: 'assistant/message', seq: n * 10 + 2, time: T0 + n * 1000 + 200,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: `答案${n}` }] } }
    },
    { type: 'turn/end', seq: n * 10 + 3, time: T0 + n * 1000 + 300, data: { turn: n, reason: { kind: reasonKind } } }
  ];
}

function writeTurnSession(lines) {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-dsh-turn-'));
  return writeSession(root, 'slug', 'session-turns', [
    { type: 'session', id: 'session-turns', createdAt: T0, cwd: '/tmp/dsh' },
    ...lines
  ]);
}

test('turns pair turn/start with turn/end', async () => {
  const file = writeTurnSession(turnLines('completed', 1));
  const p = await parseDsh(file);
  assert.equal(p.turns.length, 1);
  assert.equal(p.turns[0].turnId, '1');
  assert.equal(p.turns[0].status, 'completed');
  assert.equal(p.turns[0].signal, 'native');
  assert.equal(p.messages[p.turns[0].promptIndex].text, '问题1');
  assert.equal(p.messages[p.turns[0].finalIndex].text, '答案1');
  assert.equal(p.turns[0].startedAt, T0 + 1000);
  assert.equal(p.turns[0].endedAt, T0 + 1300);
});

test('dsh reason kinds map to normalized statuses', async () => {
  const kinds = ['completed', 'blocked', 'aborted', 'error'];
  const file = writeTurnSession(kinds.flatMap((kind, index) => turnLines(kind, index + 1)));
  const p = await parseDsh(file);
  assert.deepEqual(p.turns.map(turn => turn.status), kinds);
});

test('a new turn/start without a turn/end closes the previous turn as interrupted', async () => {
  const file = writeTurnSession([
    { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: T0 + 100,
      data: { role: 'user', content: [{ type: 'text', text: '第一问' }], source: { kind: 'user' } }
    },
    { type: 'turn/start', seq: 3, time: T0 + 1000, data: { turn: 2 } },
    {
      type: 'user/message', seq: 4, time: T0 + 1100,
      data: { role: 'user', content: [{ type: 'text', text: '第二问' }], source: { kind: 'user' } }
    },
    {
      type: 'assistant/message', seq: 5, time: T0 + 1200,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '答案' }] } }
    },
    { type: 'turn/end', seq: 6, time: T0 + 1300, data: { turn: 2, reason: { kind: 'completed' } } }
  ]);
  const p = await parseDsh(file);
  assert.deepEqual(p.turns.map(turn => turn.status), ['interrupted', 'completed']);
  assert.equal(p.messages[p.turns[0].promptIndex].text, '第一问');
  assert.equal(p.turns[0].finalIndex, null);
});

test('EOF with an unresolved tool call after the settle window is interrupted', async () => {
  const file = writeTurnSession([
    { type: 'turn/start', seq: 1, time: T0, data: { turn: 1 } },
    {
      type: 'user/message', seq: 2, time: T0 + 100,
      data: { role: 'user', content: [{ type: 'text', text: '问题' }], source: { kind: 'user' } }
    },
    { type: 'tool/call', seq: 3, time: T0 + 200, data: { callId: 'c1', name: 'bash', arguments: '{}' } }
  ]);
  assert.equal((await parseDsh(file, { mtimeMs: Date.now() })).turns.length, 0);
  const stale = await parseDsh(file, { mtimeMs: Date.now() - 60_000 });
  assert.equal(stale.turns.length, 1);
  assert.equal(stale.turns[0].status, 'interrupted');
});
