import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagePlainText, toolResultPlainText } from '../public/copy.js';

test('messagePlainText joins thinking, text, tool calls, and tool results in order', () => {
  const text = messagePlainText({
    thinking: '想一想',
    text: '答案',
    toolCalls: [{ name: 'Read', input: { file_path: '/a' } }],
    toolResults: [{ output: 'ok', isError: false }]
  });
  assert.equal(text, [
    '想一想',
    '',
    '答案',
    '',
    'tool call · Read',
    '{\n  "file_path": "/a"\n}',
    '',
    'tool result',
    'ok'
  ].join('\n'));
});

test('messagePlainText marks error tool results and serializes non-string output', () => {
  const text = messagePlainText({
    toolResults: [{ isError: true, output: { code: 1 } }]
  });
  assert.equal(text, 'tool result · error\n{\n  "code": 1\n}');
});

test('messagePlainText handles a missing tool name and string input', () => {
  assert.equal(
    messagePlainText({ toolCalls: [{ input: 'ls -la' }] }),
    'tool call · unknown\nls -la'
  );
});

test('messagePlainText returns an empty string for empty messages and adds no blank lines for plain text', () => {
  assert.equal(messagePlainText({}), '');
  assert.equal(messagePlainText({ text: '只有正文' }), '只有正文');
});

test('messagePlainText accepts localized labels', () => {
  const text = messagePlainText({
    toolCalls: [{ name: 'Read', input: 'x' }],
    toolResults: [{ output: 'y', isError: true }]
  }, {
    toolCall: name => `Tool call · ${name}`,
    toolResult: 'Tool result',
    errorSuffix: ' · error'
  });
  assert.equal(text, 'Tool call · Read\nx\n\nTool result · error\ny');
});

test('toolResultPlainText keeps strings, formats objects, and returns an empty string for empty values', () => {
  assert.equal(toolResultPlainText({ output: 'raw output' }), 'raw output');
  assert.equal(toolResultPlainText({ output: { a: 1 } }), '{\n  "a": 1\n}');
  assert.equal(toolResultPlainText({}), '');
});
