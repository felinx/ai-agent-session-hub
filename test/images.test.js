import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImageSource } from '../public/images.js';

test('相对路径指向当前会话的本地资源接口', () => {
  assert.equal(
    resolveImageSource('dsh:s1', 'session-hub-logo/live-header.png'),
    '/api/session/asset?key=dsh%3As1&path=session-hub-logo%2Flive-header.png'
  );
});

test('绝对本地路径同样走资源接口', () => {
  assert.equal(
    resolveImageSource('claude:a', '/tmp/shots/a.png'),
    '/api/session/asset?key=claude%3Aa&path=%2Ftmp%2Fshots%2Fa.png'
  );
});

test('远程与 data 图片保持原地址', () => {
  assert.equal(resolveImageSource('k', 'https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(resolveImageSource('k', 'http://example.com/a.png'), 'http://example.com/a.png');
  assert.equal(resolveImageSource('k', 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

test('拒绝非图片协议', () => {
  assert.equal(resolveImageSource('k', 'javascript:alert(1)'), null);
  assert.equal(resolveImageSource('k', 'file:///etc/passwd'), null);
});

test('没有会话或空地址时不解析相对路径', () => {
  assert.equal(resolveImageSource(null, 'a.png'), null);
  assert.equal(resolveImageSource('k', ''), null);
});
