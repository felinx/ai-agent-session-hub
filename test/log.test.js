import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp, formatDuration, formatClock, hasChanges, describeSync } from '../src/log.js';

const base = { added: 0, updated: 0, unchanged: 4, removed: 0, changes: [], total: 4, byAgent: [] };

test('stamp outputs local time as YYYY-MM-DD HH:mm:ss', () => {
  assert.equal(stamp(new Date(2026, 10, 24, 9, 5, 3)), '[2026-11-24 09:05:03]');
});

test('formatDuration distinguishes milliseconds, seconds, and minutes', () => {
  assert.equal(formatDuration(820), '820ms');
  assert.equal(formatDuration(1420), '1.4s');
  assert.equal(formatDuration(125000), '2m5s');
});

test('formatClock outputs local time to the minute and shows a placeholder for empty values', () => {
  assert.equal(formatClock(new Date(2026, 10, 24, 13, 8, 40).getTime()), '2026-11-24 13:08');
  assert.equal(formatClock(null), '—');
});

test('hasChanges is true only when added, updated, or removed counts are nonzero', () => {
  assert.equal(hasChanges(base), false);
  assert.equal(hasChanges({ ...base, added: 1 }), true);
  assert.equal(hasChanges({ ...base, updated: 1 }), true);
  assert.equal(hasChanges({ ...base, removed: 1 }), true);
  assert.equal(hasChanges({ ...base, unchanged: 9 }), false);
});

test('describeSync summarizes on one line and lists each session change with a timestamp', () => {
  const now = new Date(2026, 10, 24, 13, 20, 5);
  const lines = describeSync({
    added: 1,
    updated: 1,
    unchanged: 2,
    removed: 0,
    total: 118,
    byAgent: [{ agent: 'claude', count: 92 }, { agent: 'dsh', count: 26 }],
    changes: [
      { kind: 'added', agent: 'dsh', title: '询问自身大模型身份', messages: 12, updatedAt: new Date(2026, 10, 24, 13, 18).getTime() },
      { kind: 'updated', agent: 'claude', title: 'README 重构', messages: 40, updatedAt: new Date(2026, 10, 24, 12, 1).getTime() }
    ]
  }, 'zh', { now, elapsedMs: 820 });

  assert.equal(lines.length, 3);
  assert.equal(
    lines[0],
    '[2026-11-24 13:20:05] 同步完成 · 用时 820ms · 新增 1 · 更新 1 · 移除 0 · 共 118 个会话（claude 92 · dsh 26）'
  );
  assert.equal(
    lines[1],
    '[2026-11-24 13:20:05]   + [dsh] 询问自身大模型身份 · 12 条消息 · 更新于 2026-11-24 13:18'
  );
  assert.equal(
    lines[2],
    '[2026-11-24 13:20:05]   ~ [claude] README 重构 · 40 条消息 · 更新于 2026-11-24 12:01'
  );
});

test('describeSync outputs only the summary line when there are no changes', () => {
  const lines = describeSync(base, 'en', { now: new Date(2026, 10, 24, 13, 20, 5), elapsedMs: 120 });
  assert.deepEqual(lines, ['[2026-11-24 13:20:05] sync done · 120ms · 0 added, 0 updated, 0 removed · 4 sessions']);
});

test('describeSync omits message count and update time for removed sessions', () => {
  const lines = describeSync({
    ...base,
    removed: 1,
    changes: [{ kind: 'removed', agent: 'codex', title: '旧实验' }]
  }, 'zh', { now: new Date(2026, 10, 24, 13, 20, 5), elapsedMs: 10 });
  assert.equal(lines[1], '[2026-11-24 13:20:05]   - [codex] 旧实验 · 已从来源移除');
});

test('describeSync limits detail lines and reports remaining changes', () => {
  const changes = Array.from({ length: 5 }, (_, i) => ({
    kind: 'added', agent: 'claude', title: `会话 ${i}`, messages: 1, updatedAt: Date.now()
  }));
  const lines = describeSync({ ...base, added: 5, changes }, 'zh', {
    now: new Date(2026, 10, 24, 13, 20, 5), elapsedMs: 5, limit: 2
  });
  assert.equal(lines.length, 4);
  assert.match(lines[3], /另有 3 个会话变化/);
});
