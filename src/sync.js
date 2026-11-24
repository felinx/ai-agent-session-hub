import { stat } from 'node:fs/promises';
import path from 'node:path';
import { discoverClaude, parseClaude } from './sources/claude.js';
import { discoverCodex, parseCodex } from './sources/codex.js';
import { discoverDsh, parseDsh } from './sources/dsh.js';
import { discoverWorkbuddy, parseWorkbuddy } from './sources/workbuddy.js';
import { buildChatMap } from './sources/larkMap.js';
import {
  getSyncMeta, hasSession, replaceSession, pruneMissing, appendEvent, pruneEvents
} from './db.js';
import { SETTLE_MS } from './turns.js';
import { getSettings } from './settings.js';
import { sessionId } from './session-id.js';
import { oneLine } from './normalize.js';

const SOURCES = [
  { agent: 'claude', discover: discoverClaude, parse: parseClaude },
  { agent: 'codex', discover: discoverCodex, parse: parseCodex },
  { agent: 'dsh', discover: discoverDsh, parse: parseDsh },
  { agent: 'workbuddy', discover: discoverWorkbuddy, parse: parseWorkbuddy }
];

function getSessionMeta(db, sourcePath) {
  return db.prepare(
    'SELECT key, title, chat_id AS chatId FROM sessions WHERE source_path = ?'
  ).get(sourcePath) ?? null;
}

function resetLegacyNormalizedWorkbuddySessions(db) {
  db.prepare(`
    DELETE FROM sync_state
    WHERE source_path IN (
      SELECT source_path FROM sessions
      WHERE agent = 'workbuddy' AND cwd = 'workbuddy-default'
    )
  `).run();
}

// One-line brief of what the session last talked about: the latest non-empty message text.
function latestSummary(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i]?.text;
    if (typeof text === 'string' && text.trim() !== '') return oneLine(text, 80);
  }
  return '';
}

export async function syncOnce(db, config, opts = {}) {
  const chatMap = opts.chatMap ?? await buildChatMap(config);
  const force = !!opts.force;
  const warnings = [];
  const discovered = [];
  const settings = opts.settings ?? getSettings(db);
  const enabledAgents = new Set(settings.enabledAgents);
  const sources = SOURCES.filter(source => enabledAgents.has(source.agent));

  resetLegacyNormalizedWorkbuddySessions(db);

  const results = await Promise.all(sources.map(async source => {
    const root = config.roots[source.agent];
    try {
      await stat(root);
    } catch {
      warnings.push({ code: 'sourceRootUnavailable', params: { path: String(root) } });
      return { ok: false, files: [] };
    }
    try {
      return { ok: true, files: await source.discover(config) };
    } catch (err) {
      warnings.push({
        code: 'sourceScanFailed',
        params: { path: String(root), message: String(err?.message ?? err) }
      });
      return { ok: false, files: [] };
    }
  }));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const changes = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    for (const file of results[i].files) {
      discovered.push(file);

      const existing = getSessionMeta(db, file.sourcePath);
      const chatKey = existing?.key ?? `${file.agent}:${file.nativeId}`;
      const desiredChatId = chatMap.get(chatKey) ?? file.chatHint ?? null;
      const metadataStale = !existing ||
        (file.titleHint !== undefined && file.titleHint !== existing.title) ||
        desiredChatId !== existing.chatId;

      const state = getSyncMeta(db, file.sourcePath);
      const contentChanged = !state ||
        state.mtimeMs !== file.mtimeMs || state.size !== file.size || metadataStale;
      // An unchanged file is re-parsed once after it settles, so inferred turn endings
      // (WorkBuddy, EOF interruptions) can be emitted without a source file change.
      const settledAt = file.mtimeMs + SETTLE_MS;
      const settleDue = !contentChanged && !!state &&
        Date.now() >= settledAt && (state.lastSyncedAt ?? 0) < settledAt;
      if (!force && !contentChanged && !settleDue) {
        unchanged += 1;
        continue;
      }

      let parsed;
      try {
        parsed = await source.parse(file.sourcePath, file);
      } catch (err) {
        warnings.push({
          code: 'parseFailed',
          params: { path: file.sourcePath, message: String(err?.message ?? err) }
        });
        continue;
      }

      const key = `${file.agent}:${parsed.nativeId}`;
      const session = {
        key,
        agent: file.agent,
        nativeId: parsed.nativeId,
        title: parsed.title || '',
        cwd: parsed.cwd ?? null,
        chatId: chatMap.get(key) ?? file.chatHint ?? null,
        createdAt: parsed.createdAt ?? null,
        updatedAt: Math.floor(file.mtimeMs),
        sourcePath: file.sourcePath,
        archived: file.archived ? 1 : 0,
        messageCount: parsed.messages.length,
        tokens: parsed.tokens ?? null,
        extraJson: JSON.stringify(parsed.extra ?? null)
      };

      const isUpdate = hasSession(db, key);
      const emitsSession = contentChanged || force;
      if (isUpdate) {
        if (emitsSession) updated += 1;
        else unchanged += 1;
      } else {
        added += 1;
      }
      if (emitsSession) {
        changes.push({
          kind: isUpdate ? 'updated' : 'added',
          agent: file.agent,
          id: sessionId(key),
          key,
          project: session.cwd ? path.basename(session.cwd) : null,
          updatedAt: session.updatedAt,
          lastMessageSeq: parsed.messages.length ? parsed.messages.length - 1 : null,
          summary: latestSummary(parsed.messages)
        });
      }

      replaceSession(db, session, parsed.messages, {
        mtimeMs: file.mtimeMs,
        size: file.size
      }, {
        kind: emitsSession ? (isUpdate ? 'updated' : 'created') : null,
        turns: parsed.turns ?? []
      });
    }
  }

  let removed = 0;
  if (results.every(result => result.ok)) {
    const removedSessions = pruneMissing(
      db, new Set(discovered.map(file => file.sourcePath)), { events: true }
    );
    removed = removedSessions.length;
    for (const session of removedSessions) {
      changes.push({
        kind: 'removed', agent: session.agent, id: sessionId(session.key), key: session.key
      });
    }
  }

  appendEvent(db, {
    type: 'sync.completed',
    at: Date.now(),
    payload: { added, updated, removed }
  });
  pruneEvents(db);

  const byAgent = db.prepare(
    'SELECT agent, count(*) AS count FROM sessions GROUP BY agent ORDER BY agent'
  ).all().map(row => ({ agent: row.agent, count: row.count }));
  const total = byAgent.reduce((sum, entry) => sum + entry.count, 0);

  return { added, updated, unchanged, removed, changes, total, byAgent, warnings };
}
