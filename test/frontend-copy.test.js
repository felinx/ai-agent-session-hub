import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagePlainText, toolResultPlainText } from '../public/copy.js';

test('messagePlainText 按思考、正文、工具调用、工具结果顺序拼接', () => {
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
    '工具调用 · Read',
    '{\n  "file_path": "/a"\n}',
    '',
    '工具结果',
    'ok'
  ].join('\n'));
});

test('messagePlainText 标记错误工具结果并序列化非字符串输出', () => {
  const text = messagePlainText({
    toolResults: [{ isError: true, output: { code: 1 } }]
  });
  assert.equal(text, '工具结果 · 错误\n{\n  "code": 1\n}');
});

test('messagePlainText 处理缺失工具名与字符串参数', () => {
  assert.equal(
    messagePlainText({ toolCalls: [{ input: 'ls -la' }] }),
    '工具调用 · unknown\nls -la'
  );
});

test('messagePlainText 空消息返回空字符串，纯正文不产生多余空行', () => {
  assert.equal(messagePlainText({}), '');
  assert.equal(messagePlainText({ text: '只有正文' }), '只有正文');
});

test('messagePlainText 可接受本地化标签', () => {
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

test('toolResultPlainText 原样保留字符串，格式化对象，空值返回空字符串', () => {
  assert.equal(toolResultPlainText({ output: 'raw output' }), 'raw output');
  assert.equal(toolResultPlainText({ output: { a: 1 } }), '{\n  "a": 1\n}');
  assert.equal(toolResultPlainText({}), '');
});
