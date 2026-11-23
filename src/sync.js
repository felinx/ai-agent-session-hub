import { stat } from 'node:fs/promises';
import { discoverClaude, parseClaude } from './sources/claude.js';
import { discoverCodex, parseCodex } from './sources/codex.js';
import { discoverDsh, parseDsh } from './sources/dsh.js';
import { buildChatMap } from './sources/larkMap.js';
import { getSyncState, hasSession, replaceSession, pruneMissing } from './db.js';

const SOURCES = [
  { agent: 'claude', discover: discoverClaude, parse: parseClaude },
  { agent: 'codex', discover: discoverCodex, parse: parseCodex },
  { agent: 'dsh', discover: discoverDsh, parse: parseDsh }
];

function getSessionMeta(db, sourcePath) {
  return db.prepare(
    'SELECT key, title, chat_id AS chatId FROM sessions WHERE source_path = ?'
  ).get(sourcePath) ?? null;
}

export async function syncOnce(db, config, opts = {}) {
  const chatMap = opts.chatMap ?? await buildChatMap(config);
  const force = !!opts.force;
  const warnings = [];
  const discovered = [];

  const results = await Promise.all(SOURCES.map(async source => {
    const root = config.roots[source.agent];
    try {
      await stat(root);
    } catch {
      warnings.push(`来源根目录不可用：${root}`);
      return { ok: false, files: [] };
    }
    try {
      return { ok: true, files: await source.discover(config) };
    } catch (err) {
      warnings.push(`来源扫描失败：${root}（${err?.message ?? err}）`);
      return { ok: false, files: [] };
    }
  }));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let removed = 0;

  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i];
    for (const file of results[i].files) {
      discovered.push(file);

      const existing = getSessionMeta(db, file.sourcePath);
      const chatKey = existing?.key ?? `${file.agent}:${file.nativeId}`;
      const desiredChatId = chatMap.get(chatKey) ?? file.chatHint ?? null;
      const metadataStale = !existing ||
        (file.titleHint !== undefined && file.titleHint !== existing.title) ||
        desiredChatId !== existing.chatId;

      const state = getSyncState(db, file.sourcePath);
      if (!force && !metadataStale && state && state.mtimeMs === file.mtimeMs && state.size === file.size) {
        unchanged += 1;
        continue;
      }

      let parsed;
      try {
        parsed = await source.parse(file.sourcePath, file);
      } catch (err) {
        warnings.push(`解析失败：${file.sourcePath}（${err?.message ?? err}）`);
        continue;
      }

      const key = `${file.agent}:${parsed.nativeId}`;
      const session = {
        key,
        agent: file.agent,
        nativeId: parsed.nativeId,
        title: parsed.title || '未命名会话',
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

      if (hasSession(db, key)) updated += 1;
      else added += 1;

      replaceSession(db, session, parsed.messages, {
        mtimeMs: file.mtimeMs,
        size: file.size
      });
    }
  }

  if (results.every(result => result.ok)) {
    removed = pruneMissing(db, new Set(discovered.map(file => file.sourcePath)));
  }

  return { added, updated, unchanged, removed, warnings };
}
