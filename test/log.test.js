import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp, describeSync } from '../src/log.js';

const base = { added: 0, updated: 0, unchanged: 4, removed: 0, changes: [], total: 4, byAgent: [] };
const now = new Date(2026, 10, 24, 13, 20, 5);

test('stamp outputs local time as YYYY-MM-DD HH:mm:ss', () => {
  assert.equal(stamp(new Date(2026, 10, 24, 9, 5, 3)), '[2026-11-24 09:05:03]');
});

test('describeSync prints one line per change with the session id and a one-line summary', () => {
  const lines = describeSync({
    ...base,
    added: 1,
    updated: 1,
    changes: [
      { kind: 'added', agent: 'dsh', id: '1a2b3c4d', summary: '询问自身大模型身份' },
      { kind: 'updated', agent: 'claude', id: '8f2a1c3d', summary: 'README 重构' }
    ]
  }, 'zh', { now });

  assert.deepEqual(lines, [
    '[2026-11-24 13:20:05]   + [dsh] 1a2b3c4d 询问自身大模型身份',
    '[2026-11-24 13:20:05]   ~ [claude] 8f2a1c3d README 重构'
  ]);
});

test('describeSync prints nothing when nothing changed', () => {
  assert.deepEqual(describeSync(base, 'en', { now }), []);
});

test('describeSync marks a session as having no text when the summary is empty', () => {
  const lines = describeSync({
    ...base,
    added: 1,
    changes: [{ kind: 'added', agent: 'codex', id: 'deadbeef', summary: '' }]
  }, 'zh', { now });
  assert.deepEqual(lines, ['[2026-11-24 13:20:05]   + [codex] deadbeef （无文本内容）']);
});

test('describeSync lists removed sessions by id without a summary', () => {
  const lines = describeSync({
    ...base,
    removed: 1,
    changes: [{ kind: 'removed', agent: 'codex', id: 'c0ffee00' }]
  }, 'zh', { now });
  assert.deepEqual(lines, ['[2026-11-24 13:20:05]   - [codex] c0ffee00']);
});

test('describeSync limits change lines and reports how many are left', () => {
  const changes = Array.from({ length: 5 }, (_, i) => ({
    kind: 'added', agent: 'claude', id: `0000000${i}`, summary: `会话 ${i}`
  }));
  const lines = describeSync({ ...base, added: 5, changes }, 'zh', { now, limit: 2 });
  assert.equal(lines.length, 3);
  assert.match(lines[2], /另有 3 个会话变化/);
});
