import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSessionsByProject } from '../web/group.js';

function s(key, cwd, updatedAt) {
  return { key, cwd, updatedAt };
}

test('groups by cwd and sorts both groups and sessions by most recently updated first', () => {
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

test('sessions without a cwd go into the last group', () => {
  const groups = groupSessionsByProject([
    s('none', null, 999),
    s('a', '/p1', 100)
  ]);
  assert.deepEqual(groups.map(g => g.cwd), ['/p1', null]);
  assert.deepEqual(groups[1].sessions.map(x => x.key), ['none']);
});

test('WorkBuddy date-time directories go into workbuddy-default but preserve the original cwd of each session', () => {
  const groups = groupSessionsByProject([
    { key: 'wb1', agent: 'workbuddy', cwd: '/Users/felinx/WorkBuddy/2026-10-02-11-25-23', updatedAt: 200 },
    { key: 'wb2', agent: 'workbuddy', cwd: '/Users/felinx/WorkBuddy/2026-10-11-07-20-59', updatedAt: 100 },
    { key: 'wb3', agent: 'workbuddy', cwd: '/Users/felinx/WorkBuddy/misc', updatedAt: 300 },
    { key: 'claude1', agent: 'claude', cwd: '/Users/felinx/project/2026-10-02-11-25-23', updatedAt: 400 }
  ]);

  const fallback = groups.find(group => group.cwd === 'workbuddy-default');
  assert.ok(fallback);
  assert.deepEqual(fallback.sessions.map(session => session.key), ['wb1', 'wb2']);
  assert.equal(fallback.sessions[0].cwd, '/Users/felinx/WorkBuddy/2026-10-02-11-25-23');

  assert.ok(groups.some(group => group.cwd === '/Users/felinx/WorkBuddy/misc'));
  assert.ok(groups.some(group => group.cwd === '/Users/felinx/project/2026-10-02-11-25-23'));
});

test('returns an empty array for empty input and does not modify input order', () => {
  assert.deepEqual(groupSessionsByProject([]), []);
  const input = [s('a1', '/p1', 100), s('a2', '/p1', 200)];
  groupSessionsByProject(input);
  assert.deepEqual(input.map(x => x.key), ['a1', 'a2']);
});
