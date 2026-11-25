import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jumpButtonState, jumpScrollBehavior } from '../web/scroll.js';

test('hides jump buttons when the content is too short to scroll', () => {
  assert.deepEqual(
    jumpButtonState({ scrollTop: 0, scrollHeight: 500, clientHeight: 500 }),
    { visible: false, showTop: false, showBottom: false }
  );
});

test('shows only the jump-to-bottom button at the top and only the jump-to-top button at the bottom', () => {
  assert.deepEqual(
    jumpButtonState({ scrollTop: 0, scrollHeight: 2000, clientHeight: 800 }),
    { visible: true, showTop: false, showBottom: true }
  );
  assert.deepEqual(
    jumpButtonState({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 }),
    { visible: true, showTop: true, showBottom: false }
  );
});

test('shows both jump buttons in the middle', () => {
  assert.deepEqual(
    jumpButtonState({ scrollTop: 600, scrollHeight: 2000, clientHeight: 800 }),
    { visible: true, showTop: true, showBottom: true }
  );
});

test('uses smooth scrolling for short jumps and instant positioning for long jumps', () => {
  // Browser smooth-scroll duration grows with distance; for very long sessions it can take over ten seconds, which feels like being stuck.
  assert.equal(
    jumpScrollBehavior({ from: 1000, to: 1800, clientHeight: 800 }),
    'smooth'
  );
  assert.equal(
    jumpScrollBehavior({ from: 0, to: 200000, clientHeight: 800 }),
    'auto'
  );
  assert.equal(
    jumpScrollBehavior({ from: 0, to: 800 * 2, clientHeight: 800 }),
    'smooth'
  );
  assert.equal(
    jumpScrollBehavior({ from: 0, to: 800 * 2 + 1, clientHeight: 800 }),
    'auto'
  );
});
