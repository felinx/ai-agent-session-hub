// Log formatting: timestamps, durations, and sync change summaries. Side-effect free so it can be unit tested.

import { t } from '../public/i18n.js';

function pad(value) {
  return String(value).padStart(2, '0');
}

export function stamp(date = new Date()) {
  return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds ? `${seconds}s` : ''}`;
}

export function formatClock(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function hasChanges(result) {
  return (result?.added ?? 0) + (result?.updated ?? 0) + (result?.removed ?? 0) > 0;
}

const CHANGE_KEYS = {
  added: 'log.changeAdded',
  updated: 'log.changeUpdated',
  removed: 'log.changeRemoved'
};

// Log lines for one sync: a summary line plus at most `limit` per-session change lines.
export function describeSync(result, lang, { now = new Date(), elapsedMs = 0, limit = 8 } = {}) {
  const prefix = stamp(now);
  const byAgent = (result.byAgent ?? [])
    .filter(entry => entry.count > 0)
    .map(entry => `${entry.agent} ${entry.count}`)
    .join(' · ');
  const agents = byAgent ? (lang === 'zh' ? `（${byAgent}）` : ` (${byAgent})`) : '';

  const lines = [`${prefix} ${t(lang, 'log.sync', {
    duration: formatDuration(elapsedMs),
    added: result.added ?? 0,
    updated: result.updated ?? 0,
    removed: result.removed ?? 0,
    total: result.total ?? 0
  })}${agents}`];

  const changes = result.changes ?? [];
  for (const change of changes.slice(0, limit)) {
    const key = CHANGE_KEYS[change.kind];
    if (!key) continue;
    lines.push(`${prefix} ${t(lang, key, {
      agent: change.agent,
      title: change.title,
      messages: change.messages ?? 0,
      time: formatClock(change.updatedAt)
    })}`);
  }
  if (changes.length > limit) {
    lines.push(`${prefix} ${t(lang, 'log.changeMore', { count: changes.length - limit })}`);
  }
  return lines;
}
