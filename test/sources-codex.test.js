import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCodex, parseCodex } from '../src/sources/codex.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex');
const rollout = path.join(FIXTURES, 'rollout-1.jsonl');

function makeRoot({ withIndex }) {
  const root = mkdtempSync(path.join(tmpdir(), 'session-hub-codex-'));
  const dayDir = path.join(root, 'sessions', '2026', '11', '01');
  mkdirSync(dayDir, { recursive: true });
  copyFileSync(rollout, path.join(dayDir, 'rollout-1.jsonl'));
  copyFileSync(path.join(FIXTURES, 'subagent.jsonl'), path.join(dayDir, 'subagent.jsonl'));
  if (withIndex) copyFileSync(path.join(FIXTURES, 'session_index.jsonl'), path.join(root, 'session_index.jsonl'));
  return root;
}

test('parseCodex extracts messages, thinking, and tools', async () => {
  const p = await parseCodex(rollout, { titleHint: '检查构建' });
  assert.equal(p.nativeId, '22222222-2222-4222-8222-222222222222');
  assert.equal(p.cwd, '/tmp/codex');
  assert.equal(p.title, '检查构建');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[1].thinking, '先看日志');
  assert.deepEqual(p.messages[1].toolCalls[0], { id: 'toolu_1', name: 'shell', input: { cmd: 'ls' } });
  assert.deepEqual(p.messages[1].toolResults[0], { callId: 'toolu_1', output: 'a.txt', isError: false });
});

test('discoverCodex reads index titles and excludes subagents', async () => {
  const root = makeRoot({ withIndex: true });
  const files = await discoverCodex({ roots: { codex: root } });
  assert.equal(files.length, 1);
  assert.equal(files[0].titleHint, '检查构建');
});

test('discoverCodex excludes onboarding_checklist auxiliary sessions', async () => {
  const root = makeRoot({ withIndex: true });
  copyFileSync(
    path.join(FIXTURES, 'onboarding.jsonl'),
    path.join(root, 'sessions', '2026', '11', '01', 'rollout-onboarding.jsonl')
  );
  const files = await discoverCodex({ roots: { codex: root } });
  assert.equal(files.length, 1);
  assert.equal(files[0].nativeId, '22222222-2222-4222-8222-222222222222');
});

test('falls back to the first real user text when the index is missing', async () => {
  const root = makeRoot({ withIndex: false });
  const [file] = await discoverCodex({ roots: { codex: root } });
  const p = await parseCodex(file.sourcePath, file);
  assert.equal(p.title, '检查构建失败');
});

test('custom_tool_call_output converts content block arrays to text', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-codex-array-'));
  const target = path.join(dir, 'rollout-array.jsonl');
  writeFileSync(target, [
    JSON.stringify({
      type: 'session_meta', payload: { id: 'array-1', cwd: '/tmp/codex' }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '执行' }] }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', input: '{}' }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output', call_id: 'call_1',
        output: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }]
      }
    })
  ].join('\n') + '\n');

  const p = await parseCodex(target);
  assert.equal(p.messages[0].toolResults[0].output, 'a\nb');
});

test('skips trailing partial lines and unknown events', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-codex-extra-'));
  const target = path.join(dir, 'rollout-x.jsonl');
  copyFileSync(rollout, target);
  appendFileSync(target, '{"type":"world_state"}\n{"type":"response_item","payl');
  const p = await parseCodex(target);
  assert.equal(p.messages.length, 2);
});

function writeCodex(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-codex-turn-'));
  const target = path.join(dir, 'rollout-turn.jsonl');
  writeFileSync(target, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return target;
}

function meta() {
  return { type: 'session_meta', payload: { id: 'turn-1', cwd: '/tmp/codex' } };
}

function task(type, turnId, timestamp, extra = {}) {
  return { type: 'event_msg', timestamp, payload: { type, turn_id: turnId, ...extra } };
}

function message(role, text, timestamp) {
  return {
    type: 'response_item', timestamp,
    payload: { type: 'message', role, content: [{ type: 'input_text', text }] }
  };
}

test('turns pair task_started with task_complete by turn_id', async () => {
  const target = writeCodex([
    meta(),
    task('task_started', 't1', '2026-11-01T00:00:01.000Z'),
    message('user', '问题', '2026-11-01T00:00:01.500Z'),
    message('assistant', '中间', '2026-11-01T00:00:02.000Z'),
    message('assistant', '答案', '2026-11-01T00:00:05.000Z'),
    task('task_complete', 't1', '2026-11-01T00:00:09.000Z', { last_agent_message: '答案' })
  ]);
  const p = await parseCodex(target);
  assert.equal(p.turns.length, 1);
  assert.equal(p.turns[0].turnId, 't1');
  assert.equal(p.turns[0].status, 'completed');
  assert.equal(p.turns[0].signal, 'native');
  assert.equal(p.messages[p.turns[0].promptIndex].text, '问题');
  assert.equal(p.messages[p.turns[0].finalIndex].text, '答案');
  assert.equal(p.turns[0].startedAt, Date.parse('2026-11-01T00:00:01.000Z'));
  assert.equal(p.turns[0].endedAt, Date.parse('2026-11-01T00:00:09.000Z'));
});

test('a new task_started without task_complete closes the old turn as interrupted', async () => {
  const target = writeCodex([
    meta(),
    task('task_started', 't1', '2026-11-01T00:00:01.000Z'),
    message('user', '第一问', '2026-11-01T00:00:01.500Z'),
    task('task_started', 't2', '2026-11-01T00:00:02.000Z'),
    message('user', '第二问', '2026-11-01T00:00:02.500Z'),
    message('assistant', '答案', '2026-11-01T00:00:03.000Z'),
    task('task_complete', 't2', '2026-11-01T00:00:04.000Z')
  ]);
  const p = await parseCodex(target);
  assert.deepEqual(p.turns.map(turn => turn.status), ['interrupted', 'completed']);
  assert.equal(p.messages[p.turns[0].promptIndex].text, '第一问');
  assert.equal(p.turns[0].finalIndex, null);
  assert.equal(p.messages[p.turns[1].promptIndex].text, '第二问');
});

test('a second user message inside one task is intermediate', async () => {
  const target = writeCodex([
    meta(),
    task('task_started', 't1', '2026-11-01T00:00:01.000Z'),
    message('user', '第一问', '2026-11-01T00:00:01.500Z'),
    message('user', '补充', '2026-11-01T00:00:02.000Z'),
    message('assistant', '答案', '2026-11-01T00:00:03.000Z'),
    task('task_complete', 't1', '2026-11-01T00:00:04.000Z')
  ]);
  const p = await parseCodex(target);
  assert.equal(p.turns.length, 1);
  assert.equal(p.messages[p.turns[0].promptIndex].text, '第一问');
});

test('EOF with an unresolved tool call after the settle window is interrupted', async () => {
  const target = writeCodex([
    meta(),
    task('task_started', 't1', '2026-11-01T00:00:01.000Z'),
    message('user', '问题', '2026-11-01T00:00:01.500Z'),
    {
      type: 'response_item', timestamp: '2026-11-01T00:00:02.000Z',
      payload: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'shell', arguments: '{}' }
    }
  ]);
  assert.equal((await parseCodex(target, { mtimeMs: Date.now() })).turns.length, 0);
  const stale = await parseCodex(target, { mtimeMs: Date.now() - 60_000 });
  assert.equal(stale.turns.length, 1);
  assert.equal(stale.turns[0].status, 'interrupted');
});
