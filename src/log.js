// Log formatting: timestamps and per-session sync change lines. Side-effect free so it can be unit tested.

import { t } from '../web/i18n.js';

function pad(value) {
  return String(value).padStart(2, '0');
}

export function stamp(date = new Date()) {
  return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`;
}

const CHANGE_KEYS = {
  added: 'log.changeAdded',
  updated: 'log.changeUpdated',
  removed: 'log.changeRemoved'
};

// Log lines for one sync: at most `limit` per-session change lines. A sync that changed
// nothing logs nothing — the status page is where the overall picture lives.
export function describeSync(result, lang, { now = new Date(), limit = 8 } = {}) {
  const prefix = stamp(now);
  const lines = [];
  const changes = result?.changes ?? [];

  for (const change of changes.slice(0, limit)) {
    const key = CHANGE_KEYS[change.kind];
    if (!key) continue;
    const params = { agent: change.agent, id: change.id ?? '' };
    if (change.kind !== 'removed') {
      params.summary = change.summary || t(lang, 'log.noSummary');
    }
    lines.push(`${prefix} ${t(lang, key, params)}`);
  }

  if (changes.length > limit) {
    lines.push(`${prefix} ${t(lang, 'log.changeMore', { count: changes.length - limit })}`);
  }
  return lines;
}
