import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaude, parseClaude } from '../src/sources/claude.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const file = path.join(FIXTURES, 'claude/session-1.jsonl');

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'session-hub-claude-'));
}

test('parseClaude extracts messages, thinking, and tool results', async () => {
  const p = await parseClaude(file);
  assert.equal(p.nativeId, '11111111-1111-4111-8111-111111111111');
  assert.equal(p.cwd, '/tmp/proj');
  assert.equal(p.title, '帮我检查构建失败');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[0].role, 'user');
  assert.equal(p.messages[1].text, '我看一下。');
  assert.equal(p.messages[1].thinking, '先看日志');
  assert.deepEqual(p.messages[1].toolCalls[0], { id: 'toolu_1', name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(p.messages[1].toolResults[0], { callId: 'toolu_1', output: 'a.txt', isError: false });
});

test('skips an incomplete last line without throwing', async () => {
  const dir = tmp();
  const target = path.join(dir, 'session.jsonl');
  copyFileSync(file, target);
  appendFileSync(target, '{"type":"user","mess');
  const p = await parseClaude(target);
  assert.equal(p.messages.length, 2);
});

test('custom-title takes precedence and subagent files are ignored', async () => {
  const root = tmp();
  const projectDir = path.join(root, 'projects', 'p1');
  const nativeId = '22222222-2222-4222-8222-222222222222';
  mkdirSync(path.join(projectDir, nativeId), { recursive: true });
  copyFileSync(file, path.join(projectDir, `${nativeId}.jsonl`));
  writeFileSync(
    path.join(projectDir, nativeId, 'custom-title.json'),
    JSON.stringify({ customTitle: '自定义标题' })
  );
  writeFileSync(path.join(projectDir, 'agent-x.jsonl'), '{}\n');

  const found = await discoverClaude({ roots: { claude: root } });
  assert.equal(found.length, 1);
  assert.equal(found[0].nativeId, nativeId);
  assert.equal(found[0].titleHint, '自定义标题');

  const p = await parseClaude(found[0].sourcePath, found[0]);
  assert.equal(p.title, '自定义标题');
});

test('parses oversized tool results', async () => {
  const dir = tmp();
  const target = path.join(dir, 'big.jsonl');
  const big = 'x'.repeat(300 * 1024);
  const lines = [
    JSON.stringify({
      type: 'assistant', sessionId: 's', timestamp: '2026-11-01T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_big', name: 'Read', input: {} }] }
    }),
    JSON.stringify({
      type: 'user', sessionId: 's',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_big', content: big }] }
    })
  ];
  writeFileSync(target, lines.join('\n') + '\n');
  const p = await parseClaude(target);
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].toolResults[0].output.length, big.length);
});
