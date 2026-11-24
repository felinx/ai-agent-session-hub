import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jumpButtonState, jumpScrollBehavior } from '../public/scroll.js';

test('内容不足以滚动时隐藏跳转按钮', () => {
  assert.deepEqual(
    jumpButtonState({ scrollTop: 0, scrollHeight: 500, clientHeight: 500 }),
    { visible: false, showTop: false, showBottom: false }
  );
});

test('顶部只显示跳到底部，底部只显示跳到顶部', () => {
  assert.deepEqual(
    jumpButtonState({ scrollTop: 0, scrollHeight: 2000, clientHeight: 800 }),
    { visible: true, showTop: false, showBottom: true }
  );
  assert.deepEqual(
    jumpButtonState({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 }),
    { visible: true, showTop: true, showBottom: false }
  );
});

test('中间位置同时显示两个跳转按钮', () => {
  assert.deepEqual(
    jumpButtonState({ scrollTop: 600, scrollHeight: 2000, clientHeight: 800 }),
    { visible: true, showTop: true, showBottom: true }
  );
});

test('短距离跳转使用平滑滚动，长距离直接定位', () => {
  // 浏览器平滑滚动时长随距离增长，超长会话平滑滚动要等十几秒，体验上等同于卡住。
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
