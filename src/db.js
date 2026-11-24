import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionId } from './session-id.js';
import { oneLine } from './normalize.js';
import { eventEnvelope } from './events.js';

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

function latestSummary(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i]?.text;
    if (typeof text === 'string' && text.trim() !== '') return oneLine(text, 80);
  }
  return '';
}

function buildTurnObject(fields, promptMessage, finalMessage, overrides = {}) {
  const prompt = {
    seq: fields.promptSeq,
    at: promptMessage?.at ?? null,
    role: promptMessage?.role ?? 'user',
    text: overrides.promptText ?? promptMessage?.text ?? ''
  };
  const final = finalMessage
    ? {
      seq: fields.finalSeq,
      at: finalMessage.at ?? null,
      role: finalMessage.role ?? 'assistant',
      text: overrides.finalText ?? finalMessage.text ?? ''
    }
    : null;
  return {
    sessionKey: fields.sessionKey,
    turnSeq: fields.turnSeq,
    turnId: fields.turnId ?? null,
    status: fields.status,
    signal: fields.signal,
    startedAt: fields.startedAt ?? null,
    endedAt: fields.endedAt ?? null,
    promptSeq: fields.promptSeq,
    finalSeq: fields.finalSeq,
    prompt,
    final,
    summary: final ? oneLine(final.text ?? '', 80) : ''
  };
}

function appendSessionEvent(db, session, messages, kind, now) {
  appendEvent(db, {
    type: `session.${kind}`,
    sessionKey: session.key,
    agent: session.agent,
    at: now,
    payload: {
      session: {
        key: session.key,
        id: sessionId(session.key),
        agent: session.agent,
        project: session.cwd ? path.basename(session.cwd) : null,
        cwd: session.cwd ?? null,
        title: session.title ?? '',
        messageCount: session.messageCount ?? messages.length,
        updatedAt: session.updatedAt ?? null,
        summary: latestSummary(messages),
        lastMessageSeq: messages.length ? messages.length - 1 : null,
        archived: !!session.archived
      }
    }
  });
}

// Turns are persisted like messages: same transaction, rewritten on every parse.
// Only turns that were not already terminal (or whose status changed) reach the feed,
// so re-parsing an unchanged file does not replay old completions.
function insertTurns(db, session, messages, turns, priorTurns, now) {
  const priorStatus = new Map();
  for (const row of priorTurns) {
    priorStatus.set(row.turnId ?? `#${row.turnSeq}`, row.status);
  }

  const insert = db.prepare(`
    INSERT INTO turns (
      session_key, turn_seq, turn_id, status, signal,
      started_at, ended_at, prompt_seq, final_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let turnSeq = 0;
  for (const turn of turns ?? []) {
    const promptSeq = turn.promptIndex;
    if (!Number.isInteger(promptSeq) || !messages[promptSeq]) continue;
    const finalSeq = Number.isInteger(turn.finalIndex) ? turn.finalIndex : null;
    const finalMessage = finalSeq === null ? null : messages[finalSeq];
    if (finalSeq !== null && !finalMessage) continue;

    turnSeq += 1;
    const fields = {
      sessionKey: session.key,
      turnSeq,
      turnId: turn.turnId ?? null,
      status: turn.status ?? 'completed',
      signal: turn.signal ?? 'native',
      startedAt: turn.startedAt ?? null,
      endedAt: turn.endedAt ?? null,
      promptSeq,
      finalSeq
    };
    insert.run(
      fields.sessionKey, turnSeq, fields.turnId, fields.status, fields.signal,
      fields.startedAt, fields.endedAt, promptSeq, finalSeq
    );

    const key = fields.turnId ?? `#${turnSeq}`;
    const previous = priorStatus.get(key);
    if (previous === undefined || previous !== fields.status) {
      const turnObject = buildTurnObject(fields, messages[promptSeq], finalMessage, {
        promptText: turn.promptText,
        finalText: turn.finalText
      });
      appendEvent(db, {
        type: 'turn.completed',
        sessionKey: session.key,
        agent: session.agent,
        at: now,
        payload: { turn: turnObject }
      });
    }
  }
}

export function replaceSession(db, session, messages, sync, {
  kind = null, turns = [], now = Date.now()
} = {}) {
  transaction(db, () => {
    const replaced = db.prepare(
      'SELECT source_path FROM sessions WHERE key = ? OR source_path = ?'
    ).all(session.key, session.sourcePath);
    const priorTurns = db.prepare(
      'SELECT turn_seq AS turnSeq, turn_id AS turnId, status FROM turns WHERE session_key = ?'
    ).all(session.key);

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

    if (kind) appendSessionEvent(db, session, messages, kind, now);
    insertTurns(db, session, messages, turns, priorTurns, now);

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

export function getSyncMeta(db, sourcePath) {
  return db.prepare(`
    SELECT mtime_ms AS mtimeMs, size, last_synced_at AS lastSyncedAt
    FROM sync_state WHERE source_path = ?
  `).get(sourcePath) ?? null;
}

export function hasSession(db, key) {
  return !!db.prepare('SELECT 1 FROM sessions WHERE key = ?').get(key);
}

export function pruneMissing(db, keepPaths, { events = false, now = Date.now() } = {}) {
  return transaction(db, () => {
    const deleteFts = db.prepare('DELETE FROM messages_fts WHERE session_key = ?');
    const deleteSession = db.prepare('DELETE FROM sessions WHERE key = ?');
    const deleteSync = db.prepare('DELETE FROM sync_state WHERE source_path = ?');

    const removed = [];
    for (const row of db.prepare('SELECT key, agent, title, source_path FROM sessions').all()) {
      if (!keepPaths.has(row.source_path)) {
        if (events) {
          appendEvent(db, {
            type: 'session.removed',
            sessionKey: row.key,
            agent: row.agent,
            at: now,
            payload: {
              session: { key: row.key, id: sessionId(row.key), agent: row.agent }
            }
          });
        }
        deleteFts.run(row.key);
        deleteSession.run(row.key);
        removed.push({ key: row.key, agent: row.agent, title: row.title });
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
      DELETE FROM turns;
      DELETE FROM events;
      DELETE FROM sessions;
      DELETE FROM sync_state;
      DELETE FROM sqlite_sequence WHERE name IN ('events', 'turns');
    `);
  });
}

export function appendEvent(db, {
  type, sessionKey = null, agent = null, at = Date.now(), payload = {}
}) {
  return Number(db.prepare(
    'INSERT INTO events (type, session_key, agent, at, payload) VALUES (?, ?, ?, ?, ?)'
  ).run(type, sessionKey, agent, at, JSON.stringify(payload)).lastInsertRowid);
}

// Highest seq ever assigned, even when every row has been pruned. sqlite_sequence
// tracks AUTOINCREMENT values independently of table contents.
export function getLastEventSeq(db) {
  let sequence = 0;
  try {
    sequence = db.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'events'"
    ).get()?.seq ?? 0;
  } catch {}
  const present = db.prepare('SELECT max(seq) AS seq FROM events').get()?.seq ?? 0;
  return Math.max(Number(sequence), Number(present));
}

export function eventsSince(db, {
  since = 0,
  limit = 200,
  maxBytes = 8 * 1024 * 1024,
  agents = null,
  types = null
} = {}) {
  const head = getLastEventSeq(db);
  const oldest = db.prepare('SELECT min(seq) AS seq FROM events').get()?.seq ?? null;
  const resync = since > 0 && (
    since > head || (oldest !== null && since + 1 < oldest)
  );

  const where = ['seq > ?'];
  const params = [since];
  if (Array.isArray(agents)) {
    if (agents.length === 0) where.push('0');
    else {
      where.push(`agent IN (${agents.map(() => '?').join(', ')})`);
      params.push(...agents);
    }
  }
  if (Array.isArray(types)) {
    if (types.length === 0) where.push('0');
    else {
      where.push(`type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
  }

  const rows = db.prepare(`
    SELECT seq, type, session_key AS sessionKey, agent, at, payload
    FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?
  `).all(...params, limit + 1);

  const events = [];
  let bytes = 0;
  for (const row of rows) {
    if (events.length >= limit) break;
    const envelope = eventEnvelope(row);
    const size = Buffer.byteLength(JSON.stringify(envelope));
    if (events.length > 0 && bytes + size > maxBytes) break;
    events.push(envelope);
    bytes += size;
  }

  const hasMore = events.length < rows.length;
  let cursor = events.length > 0 ? events[events.length - 1].seq : since;
  if (events.length === 0 && resync) cursor = head;

  return { events, cursor, hasMore, resync };
}

export function pruneEvents(db, {
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  maxRows = 50_000,
  maxBytes = 256 * 1024 * 1024,
  now = Date.now()
} = {}) {
  return transaction(db, () => {
    let removed = Number(db.prepare(
      'DELETE FROM events WHERE at < ?'
    ).run(now - maxAgeMs).changes);

    const count = db.prepare('SELECT count(*) AS c FROM events').get().c;
    if (count > maxRows) {
      removed += Number(db.prepare(`
        DELETE FROM events WHERE seq NOT IN (
          SELECT seq FROM events ORDER BY seq DESC LIMIT ?
        )
      `).run(maxRows).changes);
    }

    let total = 0;
    let cutoff = null;
    for (const row of db.prepare(
      'SELECT seq, length(payload) AS size FROM events ORDER BY seq DESC'
    ).all()) {
      total += Number(row.size);
      if (total > maxBytes) {
        cutoff = row.seq;
        break;
      }
    }
    if (cutoff !== null) {
      removed += Number(db.prepare('DELETE FROM events WHERE seq <= ?').run(cutoff).changes);
    }
    return removed;
  });
}

const SESSION_COLUMNS = `
  key, agent, native_id AS nativeId, title, cwd, chat_id AS chatId,
  created_at AS createdAt, updated_at AS updatedAt, source_path AS sourcePath,
  archived, message_count AS messageCount, tokens, extra_json AS extraJson
`;

function toSession(row) {
  return { ...row, id: sessionId(row.key), archived: !!row.archived };
}

// Sessions hidden by default: empty sessions with no messages, and sessions whose cwd
// is inside a system temp directory. Prefix-match /tmp and /private/tmp children
// without catching look-alike paths such as /tmpfoo.
export function visibilityWhere({
  includeHidden = false,
  showEmpty = includeHidden,
  showTemp = includeHidden
} = {}) {
  const clauses = [];
  if (!showEmpty) clauses.push('message_count > 0');
  if (!showTemp) {
    clauses.push(`(cwd IS NULL OR (
      cwd NOT IN ('/tmp', '/tmp/', '/private/tmp', '/private/tmp/')
      AND cwd NOT LIKE '/tmp/%'
      AND cwd NOT LIKE '/private/tmp/%'
    ))`);
  }
  return clauses.length ? clauses.join(' AND ') : '1';
}

export const VISIBLE_SESSION_WHERE = visibilityWhere();

function addAgentsFilter(where, params, agents) {
  if (!Array.isArray(agents)) return;
  if (agents.length === 0) {
    where.push('0');
    return;
  }
  where.push(`agent IN (${agents.map(() => '?').join(', ')})`);
  params.push(...agents);
}

export function listSessions(db, query = {}) {
  const { agent, chat, cwd, q, since, limit = 500, includeArchived = true, includeHidden = false, agents } = query;
  const showEmpty = query.showEmpty ?? includeHidden;
  const showTemp = query.showTemp ?? includeHidden;
  const where = [visibilityWhere({ showEmpty, showTemp })];
  const params = [];

  addAgentsFilter(where, params, agents);
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

export function getSessionCwd(db, key) {
  const row = db.prepare('SELECT cwd FROM sessions WHERE key = ?').get(key);
  return row?.cwd ?? null;
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

const TURN_COLUMNS = `
  session_key AS sessionKey, turn_seq AS turnSeq, turn_id AS turnId, status, signal,
  started_at AS startedAt, ended_at AS endedAt, prompt_seq AS promptSeq, final_seq AS finalSeq
`;

function getTurnRow(db, key, turnSeq) {
  return db.prepare(
    `SELECT ${TURN_COLUMNS} FROM turns WHERE session_key = ? AND turn_seq = ?`
  ).get(key, turnSeq) ?? null;
}

function turnEndSeq(db, key, row) {
  if (row.finalSeq !== null) return row.finalSeq;
  return db.prepare(
    'SELECT max(seq) AS seq FROM messages WHERE session_key = ?'
  ).get(key)?.seq ?? row.promptSeq;
}

function messageRow(db, key, seq) {
  if (seq === null || seq === undefined) return null;
  return db.prepare(
    'SELECT seq, role, at, text FROM messages WHERE session_key = ? AND seq = ?'
  ).get(key, seq) ?? null;
}

export function getTurn(db, key, turnSeq) {
  const row = getTurnRow(db, key, turnSeq);
  if (!row) return null;
  const turn = buildTurnObject(
    row, messageRow(db, key, row.promptSeq), messageRow(db, key, row.finalSeq)
  );
  const end = turnEndSeq(db, key, row);
  const counts = db.prepare(`
    SELECT
      (SELECT count(*) FROM messages WHERE session_key = ? AND seq >= ? AND seq <= ?) AS messageCount,
      (SELECT count(*) FROM tool_calls WHERE session_key = ? AND message_seq >= ? AND message_seq <= ?) AS toolCallCount,
      (SELECT count(*) FROM tool_results WHERE session_key = ? AND message_seq >= ? AND message_seq <= ?) AS toolResultCount
  `).get(
    key, row.promptSeq, end,
    key, row.promptSeq, end,
    key, row.promptSeq, end
  );
  return { turn, ...counts };
}

export function getTurnMessages(db, key, turnSeq, {
  after = null, limit = 200, maxBytes = 2 * 1024 * 1024
} = {}) {
  const row = getTurnRow(db, key, turnSeq);
  if (!row) return null;

  const end = turnEndSeq(db, key, row);
  const startAfter = Number.isInteger(after) ? after : row.promptSeq - 1;
  const pageSize = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 200, 1000));
  const rows = db.prepare(`
    SELECT seq, role, at, text, thinking FROM messages
    WHERE session_key = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?
  `).all(key, startAfter, end, pageSize + 1);

  const callsBySeq = new Map();
  for (const call of db.prepare(`
    SELECT message_seq AS seq, call_id AS callId, name, input_json AS inputJson
    FROM tool_calls WHERE session_key = ? AND message_seq > ? AND message_seq <= ? ORDER BY id
  `).all(key, startAfter, end)) {
    let input = null;
    try { input = JSON.parse(call.inputJson ?? 'null'); } catch {}
    if (!callsBySeq.has(call.seq)) callsBySeq.set(call.seq, []);
    callsBySeq.get(call.seq).push({ id: call.callId, name: call.name, input });
  }

  const resultsBySeq = new Map();
  for (const result of db.prepare(`
    SELECT message_seq AS seq, call_id AS callId, output, is_error AS isError
    FROM tool_results WHERE session_key = ? AND message_seq > ? AND message_seq <= ? ORDER BY id
  `).all(key, startAfter, end)) {
    if (!resultsBySeq.has(result.seq)) resultsBySeq.set(result.seq, []);
    resultsBySeq.get(result.seq).push({
      callId: result.callId, output: result.output ?? '', isError: !!result.isError
    });
  }

  const messages = [];
  let bytes = 0;
  for (const rowMessage of rows) {
    if (messages.length >= pageSize) break;
    const message = {
      seq: rowMessage.seq,
      role: rowMessage.role,
      at: rowMessage.at,
      text: rowMessage.text ?? '',
      toolCalls: callsBySeq.get(rowMessage.seq) ?? [],
      toolResults: resultsBySeq.get(rowMessage.seq) ?? []
    };
    if (rowMessage.thinking !== null) message.thinking = rowMessage.thinking;
    const size = Buffer.byteLength(JSON.stringify(message));
    if (messages.length > 0 && bytes + size > maxBytes) break;
    messages.push(message);
    bytes += size;
  }

  return {
    turn: {
      sessionKey: key, turnSeq: row.turnSeq, promptSeq: row.promptSeq, finalSeq: row.finalSeq
    },
    messages,
    hasMore: messages.length < rows.length,
    nextAfter: messages.length ? messages[messages.length - 1].seq : startAfter
  };
}

export function countVisibleSessions(db, options = {}) {  const visible = visibilityWhere(options);
  const where = [visible];
  const params = [];
  addAgentsFilter(where, params, options.agents);
  return db.prepare(
    `SELECT count(*) AS c FROM sessions WHERE ${where.join(' AND ')}`
  ).get(...params).c;
}

export function getFacets(db, options = {}) {
  const visible = visibilityWhere(options);
  const where = [visible];
  const params = [];
  addAgentsFilter(where, params, options.agents);
  const base = where.join(' AND ');

  return {
    agents: db.prepare(
      `SELECT agent, count(*) AS count FROM sessions WHERE ${base} GROUP BY agent ORDER BY agent`
    ).all(...params),
    chats: db.prepare(
      `SELECT chat_id AS chatId, count(*) AS count FROM sessions
       WHERE chat_id IS NOT NULL AND ${base} GROUP BY chat_id ORDER BY chat_id`
    ).all(...params),
    cwds: db.prepare(
      `SELECT cwd, count(*) AS count FROM sessions
       WHERE cwd IS NOT NULL AND ${base} GROUP BY cwd ORDER BY count DESC, cwd`
    ).all(...params)
  };
}

// Per-agent overview for the status page: totals plus the newest session and a
// one-line summary of its latest non-empty message.
export function getAgentStats(db) {
  const rows = db.prepare(`
    SELECT agent, count(*) AS sessions, coalesce(sum(message_count), 0) AS messages,
           max(updated_at) AS lastSyncAt
    FROM sessions GROUP BY agent ORDER BY agent
  `).all();

  const latestRow = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE agent = ? ORDER BY updated_at DESC LIMIT 1`
  );
  const lastText = db.prepare(`
    SELECT text FROM messages
    WHERE session_key = ? AND text IS NOT NULL AND trim(text) <> ''
    ORDER BY seq DESC LIMIT 1
  `);

  return rows.map(row => {
    const latest = latestRow.get(row.agent);
    if (!latest) return { ...row, latest: null };
    const message = lastText.get(latest.key);
    return {
      ...row,
      latest: { ...toSession(latest), summary: oneLine(message?.text ?? '') }
    };
  });
}
