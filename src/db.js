import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const dbPaths = new WeakMap();

function secureDbFiles(dbPath) {
  if (!dbPath || dbPath === ':memory:') return;
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  try { chmodSync(path.dirname(dbPath), 0o700); } catch {}
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
    db.prepare('DELETE FROM messages_fts WHERE session_key = ?').run(session.key);
    db.prepare('DELETE FROM sessions WHERE key = ? OR source_path = ?')
      .run(session.key, session.sourcePath);

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
