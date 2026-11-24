CREATE TABLE IF NOT EXISTS sessions (
  key          TEXT PRIMARY KEY,
  agent        TEXT NOT NULL,
  native_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  cwd          TEXT,
  chat_id      TEXT,
  created_at   INTEGER,
  updated_at   INTEGER NOT NULL,
  source_path  TEXT NOT NULL UNIQUE,
  archived     INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  tokens       INTEGER,
  extra_json   TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  at          INTEGER,
  text        TEXT NOT NULL DEFAULT '',
  thinking    TEXT,
  UNIQUE(session_key, seq)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  message_seq INTEGER NOT NULL,
  call_id     TEXT,
  name        TEXT,
  input_json  TEXT
);

CREATE TABLE IF NOT EXISTS tool_results (
  id          INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  message_seq INTEGER NOT NULL,
  call_id     TEXT,
  output      TEXT,
  is_error    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
  source_path    TEXT PRIMARY KEY,
  mtime_ms       REAL NOT NULL,
  size           INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Durable change feed. AUTOINCREMENT is deliberate: without it SQLite may reuse
-- rowids after deletes, which would break cursor semantics.
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  session_key TEXT,
  agent       TEXT,
  at          INTEGER NOT NULL,
  payload     TEXT NOT NULL
);

-- Derived turn boundaries. Written in the same transaction as the session they belong to.
CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  turn_seq    INTEGER NOT NULL,
  turn_id     TEXT,
  status      TEXT NOT NULL,
  signal      TEXT NOT NULL,
  started_at  INTEGER,
  ended_at    INTEGER,
  prompt_seq  INTEGER,
  final_seq   INTEGER,
  prompt_text TEXT,
  final_text  TEXT,
  UNIQUE(session_key, turn_seq)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_key UNINDEXED,
  seq UNINDEXED,
  body,
  tokenize = 'trigram'
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_updated ON sessions(agent, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_key, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_key);
CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_key);
CREATE INDEX IF NOT EXISTS idx_events_type_seq ON events(type, seq);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_key, seq);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_key, turn_seq);
