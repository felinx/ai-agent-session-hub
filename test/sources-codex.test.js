import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs';
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

test('parseCodex 提取消息、思考、工具', async () => {
  const p = await parseCodex(rollout, { titleHint: '检查构建' });
  assert.equal(p.nativeId, '22222222-2222-4222-8222-222222222222');
  assert.equal(p.cwd, '/tmp/codex');
  assert.equal(p.title, '检查构建');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[1].thinking, '先看日志');
  assert.deepEqual(p.messages[1].toolCalls[0], { id: 'toolu_1', name: 'shell', input: { cmd: 'ls' } });
  assert.deepEqual(p.messages[1].toolResults[0], { callId: 'toolu_1', output: 'a.txt', isError: false });
});

test('discoverCodex 读取索引标题并排除子代理', async () => {
  const root = makeRoot({ withIndex: true });
  const files = await discoverCodex({ roots: { codex: root } });
  assert.equal(files.length, 1);
  assert.equal(files[0].titleHint, '检查构建');
});

test('缺失索引时回退首条真实用户文本', async () => {
  const root = makeRoot({ withIndex: false });
  const [file] = await discoverCodex({ roots: { codex: root } });
  const p = await parseCodex(file.sourcePath, file);
  assert.equal(p.title, '检查构建失败');
});

test('末尾半行与未知事件被跳过', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-hub-codex-extra-'));
  const target = path.join(dir, 'rollout-x.jsonl');
  copyFileSync(rollout, target);
  appendFileSync(target, '{"type":"world_state"}\n{"type":"response_item","payl');
  const p = await parseCodex(target);
  assert.equal(p.messages.length, 2);
});
