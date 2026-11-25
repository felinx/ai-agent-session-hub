import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImageSource } from '../web/images.js';

test('relative paths point to the local asset endpoint for the current session', () => {
  assert.equal(
    resolveImageSource('dsh:s1', 'session-hub-logo/live-header.png'),
    '/api/session/asset?key=dsh%3As1&path=session-hub-logo%2Flive-header.png'
  );
});

test('absolute local paths also go through the asset endpoint', () => {
  assert.equal(
    resolveImageSource('claude:a', '/tmp/shots/a.png'),
    '/api/session/asset?key=claude%3Aa&path=%2Ftmp%2Fshots%2Fa.png'
  );
});

test('remote and data URLs keep their original addresses', () => {
  assert.equal(resolveImageSource('k', 'https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(resolveImageSource('k', 'http://example.com/a.png'), 'http://example.com/a.png');
  assert.equal(resolveImageSource('k', 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

test('rejects non-image protocols', () => {
  assert.equal(resolveImageSource('k', 'javascript:alert(1)'), null);
  assert.equal(resolveImageSource('k', 'file:///etc/passwd'), null);
});

test('does not resolve relative paths without a session or with an empty address', () => {
  assert.equal(resolveImageSource(null, 'a.png'), null);
  assert.equal(resolveImageSource('k', ''), null);
});
