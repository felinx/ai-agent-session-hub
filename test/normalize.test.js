import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textFromContent, stripBridgeContext, isSyntheticUserText,
  deriveTitle, toEpochMs, truncate
} from '../src/normalize.js';

test('textFromContent joins text blocks', () => {
  assert.equal(textFromContent('hi'), 'hi');
  assert.equal(textFromContent([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(textFromContent([{ type: 'input_text', text: 'q' }, { type: 'output_text', text: 'a' }]), 'q\na');
  assert.equal(textFromContent(null), '');
});

test('stripBridgeContext and synthetic text detection', () => {
  const t = '<bridge_context>{"chatId":"oc_1"}</bridge_context>\n你好';
  assert.equal(stripBridgeContext(t), '你好');
  const instructions = '<bridge_context>{}</bridge_context>\n<bridge_instructions>你在 bridge 中运行</bridge_instructions>\n';
  assert.equal(stripBridgeContext(instructions), '');
  assert.equal(deriveTitle(instructions, 'Untitled'), 'Untitled');

  const wrapped = '<bridge_context>{}</bridge_context>\n<bridge_instructions>x</bridge_instructions>\n' +
    '<user_input>\n{"text":"检查构建"}\n</user_input>';
  assert.equal(stripBridgeContext(wrapped), '检查构建');
  assert.equal(deriveTitle(wrapped), '检查构建');
  assert.equal(isSyntheticUserText('<environment_context>...</environment_context>'), true);
  assert.equal(isSyntheticUserText('<recommended_plugins>x</recommended_plugins>'), true);
  assert.equal(isSyntheticUserText('<system-reminder>x</system-reminder>'), true);
  assert.equal(isSyntheticUserText('你好'), false);
});

test('deriveTitle takes the first line and truncates', () => {
  assert.equal(deriveTitle('第一行\n第二行'), '第一行');
  assert.equal(deriveTitle('<bridge_context>{}</bridge_context>\n检查构建'), '检查构建');
  assert.equal(deriveTitle('', 'Untitled'), 'Untitled');
  assert.equal(deriveTitle('x'.repeat(200)).length, 80);
});

test('toEpochMs handles four input forms', () => {
  assert.equal(toEpochMs('2026-11-01T00:00:00.000Z'), Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(toEpochMs(1795000000), 1795000000000);
  assert.equal(toEpochMs(1795000000000), 1795000000000);
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs('not a date'), null);
});

test('truncate keeps only the first n characters', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('ab', 3), 'ab');
  assert.equal(truncate('', 3), '');
});
