import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSessionsByProject } from '../public/group.js';

function s(key, cwd, updatedAt) {
  return { key, cwd, updatedAt };
}

test('按 cwd 分组，组间与组内均按最近更新倒序', () => {
  const groups = groupSessionsByProject([
    s('a1', '/p1', 100),
    s('b1', '/p2', 300),
    s('a2', '/p1', 200),
    s('b2', '/p2', 150)
  ]);
  assert.deepEqual(groups.map(g => g.cwd), ['/p2', '/p1']);
  assert.deepEqual(groups[0].sessions.map(x => x.key), ['b1', 'b2']);
  assert.deepEqual(groups[1].sessions.map(x => x.key), ['a2', 'a1']);
});

test('无 cwd 的会话归入末尾分组', () => {
  const groups = groupSessionsByProject([
    s('none', null, 999),
    s('a', '/p1', 100)
  ]);
  assert.deepEqual(groups.map(g => g.cwd), ['/p1', null]);
  assert.deepEqual(groups[1].sessions.map(x => x.key), ['none']);
});

test('空数组返回空数组，且不修改输入顺序', () => {
  assert.deepEqual(groupSessionsByProject([]), []);
  const input = [s('a1', '/p1', 100), s('a2', '/p1', 200)];
  groupSessionsByProject(input);
  assert.deepEqual(input.map(x => x.key), ['a1', 'a2']);
});
