import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionId } from '../src/session-id.js';

test('sessionId is a stable 8-character hex id derived from the session key', () => {
  const id = sessionId('claude:11111111-1111-4111-8111-111111111111');
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(sessionId('claude:11111111-1111-4111-8111-111111111111'), id);
});

test('sessionId differs between sessions and between agents sharing a native id', () => {
  const a = sessionId('claude:s1');
  const b = sessionId('claude:s2');
  const c = sessionId('codex:s1');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('sessionId tolerates missing input', () => {
  assert.match(sessionId(), /^[0-9a-f]{8}$/);
});
