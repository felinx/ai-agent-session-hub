import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, appendFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkbuddy, parseWorkbuddy } from '../src/sources/workbuddy.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const file = path.join(FIXTURES, 'workbuddy/session-1.jsonl');

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'session-hub-workbuddy-'));
}

function writeLines(root, slug, name, lines) {
  const dir = path.join(root, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  writeFileSync(target, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return target;
}

test('parseWorkbuddy groups assistant turns and filters internal records', async () => {
  const p = await parseWorkbuddy(file);
  assert.equal(p.nativeId, '44444444-4444-4444-8444-444444444444');
  assert.equal(p.cwd, '/tmp/workbuddy');
  assert.equal(p.title, '项目结构梳理');
  assert.equal(p.createdAt, 1795000000000);
  assert.equal(p.messages.length, 3);

  assert.equal(p.messages[0].role, 'user');
  assert.equal(p.messages[0].text, '帮我梳理项目结构');

  const first = p.messages[1];
  assert.equal(first.role, 'assistant');
  assert.equal(first.text, '我先看看。');
  assert.equal(first.thinking, '先读目录');
  assert.deepEqual(first.toolCalls[0], { id: 'call-1', name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(first.toolResults[0], { callId: 'call-1', output: 'a.txt', isError: false });

  const second = p.messages[2];
  assert.equal(second.text, '结果如下');
  assert.deepEqual(second.toolCalls[0], { id: 'call-2', name: 'Read', input: { path: 'a.txt' } });
  assert.deepEqual(second.toolResults[0], { callId: 'call-2', output: 'boom', isError: true });
});

test('handles system context, background notifications, and image placeholders, skipping an incomplete last line', async () => {
  const root = tmp();
  const target = path.join(root, 'session.jsonl');
  writeFileSync(target, [
    {
      type: 'message', timestamp: 1795000001000, role: 'user',
      content: [{ type: 'image_blob_ref', original_filename: 'IMG_1.JPG', blob_id: 'b1' }],
      providerData: {}, cwd: '/tmp/workbuddy'
    },
    {
      type: 'message', timestamp: 1795000001100, role: 'user',
      content: '<teammate-message teammate_id="system">后台任务完成</teammate-message>',
      providerData: {}, cwd: '/tmp/workbuddy'
    },
    {
      type: 'message', timestamp: 1795000001200, role: 'user',
      content: [{ type: 'input_text', text: '真实问题' }],
      providerData: {}, cwd: '/tmp/workbuddy'
    },
    {
      type: 'message', timestamp: 1795000001300, role: 'assistant',
      content: [{ type: 'output_text', text: '回答' }],
      providerData: { messageId: 'a1' }, cwd: '/tmp/workbuddy'
    }
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  appendFileSync(target, '{"type":"message","role":"user"');

  const p = await parseWorkbuddy(target);
  assert.equal(p.title, '真实问题');
  assert.equal(p.messages.length, 3);
  assert.equal(p.messages[0].text, '[image: IMG_1.JPG]');
  assert.equal(p.messages[1].text, '真实问题');
  assert.equal(p.messages[2].text, '回答');
});

test('preserves the original cwd for system-generated date-time directories', async () => {
  const root = tmp();
  const target = path.join(root, 'session.jsonl');
  writeFileSync(target, [
    {
      type: 'message', timestamp: 1795000001000, role: 'user',
      content: [{ type: 'input_text', text: '默认项目会话' }],
      providerData: {}, cwd: '/Users/felinx/WorkBuddy/2026-10-02-11-25-23'
    }
  ].map(line => JSON.stringify(line)).join('\n') + '\n');

  const p = await parseWorkbuddy(target);
  assert.equal(p.cwd, '/Users/felinx/WorkBuddy/2026-10-02-11-25-23');
});

test('preserves the raw string when tool arguments are not valid JSON', async () => {
  const root = tmp();
  const target = path.join(root, 'session.jsonl');
  writeFileSync(target, [
    {
      type: 'message', timestamp: 1795000001000, role: 'assistant',
      content: [{ type: 'output_text', text: '调用工具' }],
      providerData: { messageId: 'a1' }, cwd: '/tmp/workbuddy'
    },
    {
      type: 'function_call', timestamp: 1795000001100,
      providerData: { messageId: 'a1' }, callId: 'call-1', name: 'Bash',
      arguments: '{not json}', cwd: '/tmp/workbuddy'
    }
  ].map(line => JSON.stringify(line)).join('\n') + '\n');

  const p = await parseWorkbuddy(target);
  assert.equal(p.messages[0].toolCalls[0].input, '{not json}');
});

test('assistant messages inherit record timestamps when there are only reasoning or tool records', async () => {
  const root = tmp();
  const target = path.join(root, 'session.jsonl');
  writeFileSync(target, [
    {
      type: 'reasoning', timestamp: 1795000005000,
      providerData: { messageId: 'a1' },
      rawContent: [{ type: 'reasoning_text', text: '只有思考' }], content: [], cwd: '/tmp/workbuddy'
    }
  ].map(line => JSON.stringify(line)).join('\n') + '\n');

  const p = await parseWorkbuddy(target);
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].role, 'assistant');
  assert.equal(p.messages[0].thinking, '只有思考');
  assert.equal(p.messages[0].at, 1795000005000);
});

test('discoverWorkbuddy collects only UUID-named jsonl sessions', async () => {
  const root = tmp();
  const nativeId = '55555555-5555-4555-8555-555555555555';
  copyFileSync(file, writeLines(root, 'Users-felinx-WorkBuddy-misc', `${nativeId}.jsonl`, []));
  writeFileSync(path.join(root, 'projects', 'Users-felinx-WorkBuddy-misc', 'notes.jsonl'), '{}\n');
  mkdirSync(path.join(root, 'projects', 'Users-felinx-WorkBuddy-misc', 'nested'), { recursive: true });

  const found = await discoverWorkbuddy({ roots: { workbuddy: root } });
  assert.equal(found.length, 1);
  assert.equal(found[0].agent, 'workbuddy');
  assert.equal(found[0].nativeId, nativeId);
  assert.equal(found[0].archived, false);
  assert.ok(found[0].size > 0);

  assert.deepEqual(await discoverWorkbuddy({ roots: { workbuddy: path.join(root, 'missing') } }), []);
});
