import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const dbPaths = new WeakMap();
const APP_DB_DIR = path.join(os.homedir(), '.session-hub');

function secureDbFiles(dbPath) {
  if (!dbPath || dbPath === ':memory:') return;
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (path.resolve(dir) === path.resolve(APP_DB_DIR)) {
    try { chmodSync(dir, 0o700); } catch {}
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { chmodSync(dbPath + suffix, 0o600); } catch {}
  }
}

export function openDb(dbPath) {
  secureDbFiles(dbPath);
  const db = new DatabaseSync(dbPath);
  dbPaths.set(db, dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  secureDbFiles(dbPath);
  return db;
}

export function initSchema(db) {
  db.exec(schemaSql);
  secureDbFiles(dbPaths.get(db));
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function replaceSession(db, session, messages, sync) {
  transaction(db, () => {
    const replaced = db.prepare(
      'SELECT source_path FROM sessions WHERE key = ? OR source_path = ?'
    ).all(session.key, session.sourcePath);

    db.prepare('DELETE FROM messages_fts WHERE session_key = ?').run(session.key);
    db.prepare('DELETE FROM sessions WHERE key = ? OR source_path = ?')
      .run(session.key, session.sourcePath);

    const deleteSyncState = db.prepare('DELETE FROM sync_state WHERE source_path = ?');
    for (const row of replaced) {
      if (row.source_path !== session.sourcePath) deleteSyncState.run(row.source_path);
    }

    db.prepare(`
      INSERT INTO sessions (
        key, agent, native_id, title, cwd, chat_id, created_at, updated_at,
        source_path, archived, message_count, tokens, extra_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.key, session.agent, session.nativeId, session.title,
      session.cwd ?? null, session.chatId ?? null, session.createdAt ?? null,
      session.updatedAt, session.sourcePath, session.archived ? 1 : 0,
      session.messageCount ?? messages.length, session.tokens ?? null,
      session.extraJson ?? null
    );

    const insertMessage = db.prepare(
      'INSERT INTO messages (session_key, seq, role, at, text, thinking) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertCall = db.prepare(
      'INSERT INTO tool_calls (session_key, message_seq, call_id, name, input_json) VALUES (?, ?, ?, ?, ?)'
    );
    const insertResult = db.prepare(
      'INSERT INTO tool_results (session_key, message_seq, call_id, output, is_error) VALUES (?, ?, ?, ?, ?)'
    );
    const insertFts = db.prepare(
      'INSERT INTO messages_fts (session_key, seq, body) VALUES (?, ?, ?)'
    );

    messages.forEach((message, seq) => {
      insertMessage.run(
        session.key, seq, message.role,
        message.at ?? null, message.text ?? '', message.thinking ?? null
      );
      for (const call of message.toolCalls ?? []) {
        insertCall.run(
          session.key, seq, call.id ?? null, call.name ?? null,
          JSON.stringify(call.input ?? null)
        );
      }
      for (const result of message.toolResults ?? []) {
        insertResult.run(
          session.key, seq, result.callId ?? null, result.output ?? '',
          result.isError ? 1 : 0
        );
      }
      if (message.role === 'user' || message.role === 'assistant') {
        insertFts.run(
          session.key, seq,
          (message.text ?? '') + '\n' + (message.thinking ?? '')
        );
      }
    });

    db.prepare(`
      INSERT INTO sync_state (source_path, mtime_ms, size, last_synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        last_synced_at = excluded.last_synced_at
    `).run(session.sourcePath, sync.mtimeMs, sync.size, Date.now());
  });
}

export function getSyncState(db, sourcePath) {
  const row = db.prepare(
    'SELECT mtime_ms AS mtimeMs, size FROM sync_state WHERE source_path = ?'
  ).get(sourcePath);
  return row ? { mtimeMs: row.mtimeMs, size: row.size } : null;
}

export function hasSession(db, key) {
  return !!db.prepare('SELECT 1 FROM sessions WHERE key = ?').get(key);
}

export function pruneMissing(db, keepPaths) {
  return transaction(db, () => {
    const deleteFts = db.prepare('DELETE FROM messages_fts WHERE session_key = ?');
    const deleteSession = db.prepare('DELETE FROM sessions WHERE key = ?');
    const deleteSync = db.prepare('DELETE FROM sync_state WHERE source_path = ?');

    let removed = 0;
    for (const row of db.prepare('SELECT key, source_path FROM sessions').all()) {
      if (!keepPaths.has(row.source_path)) {
        deleteFts.run(row.key);
        deleteSession.run(row.key);
        removed++;
      }
    }
    for (const row of db.prepare('SELECT source_path FROM sync_state').all()) {
      if (!keepPaths.has(row.source_path)) deleteSync.run(row.source_path);
    }
    return removed;
  });
}

export function clearAll(db) {
  transaction(db, () => {
    db.exec(`
      DELETE FROM messages_fts;
      DELETE FROM tool_results;
      DELETE FROM tool_calls;
      DELETE FROM messages;
      DELETE FROM sessions;
      DELETE FROM sync_state;
    `);
  });
}

const SESSION_COLUMNS = `
  key, agent, native_id AS nativeId, title, cwd, chat_id AS chatId,
  created_at AS createdAt, updated_at AS updatedAt, source_path AS sourcePath,
  archived, message_count AS messageCount, tokens, extra_json AS extraJson
`;

function toSession(row) {
  return { ...row, archived: !!row.archived };
}

// 默认隐藏的会话：没有消息的空会话，以及位于系统临时目录下的会话。
// 用 cwd 前缀匹配 /tmp、/private/tmp 的子目录，但不误伤 /tmpfoo 这类路径。
export const VISIBLE_SESSION_WHERE = `
  message_count > 0
  AND (cwd IS NULL OR (
    cwd NOT IN ('/tmp', '/tmp/', '/private/tmp', '/private/tmp/')
    AND cwd NOT LIKE '/tmp/%'
    AND cwd NOT LIKE '/private/tmp/%'
  ))
`;

export function listSessions(db, query = {}) {
  const { agent, chat, cwd, q, since, limit = 500, includeArchived = true, includeHidden = false } = query;
  const where = [];
  const params = [];

  if (!includeHidden) where.push(VISIBLE_SESSION_WHERE);
  if (agent) { where.push('agent = ?'); params.push(agent); }
  if (chat) { where.push('chat_id = ?'); params.push(chat); }
  if (cwd) { where.push('cwd = ?'); params.push(cwd); }
  if (since) { where.push('updated_at >= ?'); params.push(since); }
  if (!includeArchived) where.push('archived = 0');

  if (q) {
    if (q.length >= 3) {
      const expr = '"' + q.replaceAll('"', '""') + '"';
      where.push('key IN (SELECT session_key FROM messages_fts WHERE body MATCH ?)');
      params.push(expr);
    } else {
      const escaped = q.replace(/[\\%_]/g, '\\$&');
      const like = `%${escaped}%`;
      where.push("key IN (SELECT session_key FROM messages WHERE text LIKE ? ESCAPE '\\' OR thinking LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
  }

  const sql = `
    SELECT ${SESSION_COLUMNS} FROM sessions
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY updated_at DESC LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params).map(toSession);
}

export function getSession(db, key) {
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE key = ?`).get(key);
  if (!row) return null;

  const rows = db.prepare(
    'SELECT seq, role, at, text, thinking FROM messages WHERE session_key = ? ORDER BY seq'
  ).all(key);
  const messages = rows.map(m => {
    const message = { role: m.role, at: m.at, text: m.text ?? '', toolCalls: [], toolResults: [] };
    if (m.thinking !== null) message.thinking = m.thinking;
    return message;
  });
  const indexBySeq = new Map(rows.map((m, i) => [m.seq, i]));

  for (const call of db.prepare(
    'SELECT message_seq, call_id, name, input_json FROM tool_calls WHERE session_key = ? ORDER BY id'
  ).all(key)) {
    const i = indexBySeq.get(call.message_seq);
    if (i === undefined) continue;
    let input = null;
    try { input = JSON.parse(call.input_json ?? 'null'); } catch {}
    messages[i].toolCalls.push({ id: call.call_id, name: call.name, input });
  }

  for (const result of db.prepare(
    'SELECT message_seq, call_id, output, is_error FROM tool_results WHERE session_key = ? ORDER BY id'
  ).all(key)) {
    const i = indexBySeq.get(result.message_seq);
    if (i === undefined) continue;
    messages[i].toolResults.push({
      callId: result.call_id, output: result.output ?? '', isError: !!result.is_error
    });
  }

  return { session: toSession(row), messages };
}

export function getFacets(db, { includeHidden = false } = {}) {
  const visible = includeHidden ? '1' : VISIBLE_SESSION_WHERE;
  return {
    agents: db.prepare(
      `SELECT agent, count(*) AS count FROM sessions WHERE ${visible} GROUP BY agent ORDER BY agent`
    ).all(),
    chats: db.prepare(
      `SELECT chat_id AS chatId, count(*) AS count FROM sessions
       WHERE chat_id IS NOT NULL AND ${visible} GROUP BY chat_id ORDER BY chat_id`
    ).all(),
    cwds: db.prepare(
      `SELECT cwd, count(*) AS count FROM sessions
       WHERE cwd IS NOT NULL AND ${visible} GROUP BY cwd ORDER BY count DESC, cwd`
    ).all()
  };
}
