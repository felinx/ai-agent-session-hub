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
