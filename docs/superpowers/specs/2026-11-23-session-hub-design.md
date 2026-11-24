# Session Hub — Read-Only Session Aggregation Dashboard Design

- Date: 2026-11-23
- Status: awaiting approval (MVP)
- Working directory: `/Users/felinx/Documents/Claude/ai-agent-session-hub`

## 1. Intent and rationale

The user uses three agents through two bridges in Feishu every day:

- the Claude and Codex profiles of `lark-coding-agent-bridge` (v0.7.1 locally)
- dsh (DeepSeek Harness) through `dsh-lark-channel`

They want to aggregate the sessions of all agents in one place and first gain a unified cross-agent view: browse, search, review. The read-only MVP validates whether that view is worthwhile; continuing a conversation or dispatching work is a later phase and out of scope here.

## 2. Goals / non-goals / anti-goals

### Goals

1. Start with one command on the local machine and open a dashboard in the browser.
2. Automatically discover every session from all three sources and present them in one list.
3. Filter by agent, Feishu chat, working directory, and time; support full-text search.
4. Open any session to read the full conversation, with tool calls and results collapsed by default.
5. When a session file changes, the page refreshes automatically within seconds.
6. Never modify any source data.
7. Structurally copy the sessions read into our own SQLite database; the list, detail, and search all operate on this copy, which can be rebuilt at any time.

### Non-goals

- Continuing, resuming, forking, or writing back to any agent.
- Fetching chat names, members, or messages through the Feishu API.
- Authentication, multi-user support, remote access, cross-machine sync.
- Streaming the live token output of a running agent (refresh only follows what has landed on disk).
- Image attachment previews (show the attachment path or a placeholder first).

### Anti-goals

- Requiring changes to, or a restart of, either bridge in order to work.
- Depending on any cloud service or external network request.
- Sustained high CPU after startup, or repeated full scans of 188MB.

## 3. Constraints

- macOS, Node v26.13.1 locally (≥ 22.15 is required for the `node:zlib` zstd API).
- **Zero runtime dependencies**: use only `node:http`, `node:fs/promises`, `node:zlib`, `node:path`, `node:os`, `node:sqlite`.
  - `node:sqlite` is built in since Node 22.5; the local SQLite 3.54.1 has been verified to support FTS5 trigram.
- Data volume (measured 2026-11-23):
  - Claude: 102 `.jsonl` files, about 188MB; among them **52 top-level UUID sessions**, and 51 subagent transcripts (excluded from the session list)
  - Codex: 21 rollouts across active and archived; 3 of them are fork/subagent threads (excluded from the session list)
  - dsh: 16 sessions, about 3.3MB compressed

> The numbers are a snapshot and will grow with use; acceptance is defined by the rules for “user-visible sessions”, not by hardcoded counts.
- Upstream formats will change: parsers must be tolerant and skip unknown events / blocks with a warning, never failing as a whole.
- Source directories are read-only; the application's own writes happen only under `~/.session-hub/`; the server binds only to `127.0.0.1`.

## 4. Option selection

| Option | Description | Conclusion |
|---|---|---|
| **A. Standalone local web dashboard** | A new zero-dependency Node service scans the three sources and exposes a unified API + browser UI; it never touches the bridges | **Chosen** |
| B. Extend the lark-coding-agent-bridge console | Add a Sessions page to its `web/`, reusing the React console | Rejected: couples us to a third-party repo; cannot cover dsh; expensive to merge on upstream upgrades |
| C. Terminal CLI/TUI | `shub list/show/search` | Rejected: long conversations are hard to read in a terminal; does not feel like an “app” |

Why A: read-only, zero intrusion, all three sources treated equally; bridge upgrades and dsh upgrades do not affect it; if “continue chat / dispatch work” is added later, this service is the natural home for it.

## 5. Data sources and normalization

All paths derive from `os.homedir()` by default and can be overridden by environment variables (see §9).

### 5.1 Claude (the claude profile of lark-coding-agent-bridge)

- **Files**: `~/.claude/projects/<project-slug>/<sessionId>.jsonl`
  - Take only `*.jsonl` at the **top level** of project directories whose filename is a UUID.
  - Ignore `agent-*.jsonl` (subagent transcripts) and `<sessionId>/` subdirectories (`custom-title.json`, `tool-results/`, `subagents/`). Subagents are internal threads and do not enter the MVP list.
- **Title**:
  1. `customTitle` from `~/.claude/projects/<project-slug>/<sessionId>/custom-title.json`
  2. Otherwise the first “real user text”, cleaned and truncated to 80 characters
     - skip internal entries starting with `<local-command-caveat>...`, `<local-command-...>`, `<command-...>`
     - remove `<bridge_context>...</bridge_context>` blocks
     - take the first non-empty line
  3. Otherwise `未命名会话`
- **Metadata**: `cwd` and `sessionId` come from entry fields; the first entry carrying a `timestamp` provides `createdAt`; the file mtime is the fallback for `updatedAt`.
- **Messages**: only handle entries with `type === "user" | "assistant"`:
  - `message.content` may be a string or an array of blocks. Block types:
    - `text` → text
    - `thinking` / `redacted_thinking` → collapsed thinking
    - `tool_use` → `{id, name, input}`
    - `tool_result` → associated with the matching call through `tool_use_id`
  - A single entry may mix text and tool blocks.
  - `timestamp` is an ISO string.
- **Ignored**: internal events such as `attachment`, `api-request`, `api-request-shape`, `api-request-blob`, `queue-operation`, `atis-latch`, `last-prompt`, `tools-used`, `summary` (not present locally), etc.
- **Tolerance**: a line that fails JSON parsing is skipped; a fatal per-file error records a warning and skips that session.

### 5.2 Codex (the codex profile of lark-coding-agent-bridge)

- **Files**:
  - `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  - `~/.codex/archived_sessions/rollout-*.jsonl` (marked `archived: true`)
- **Exclude subagents**: rollouts whose `session_meta.payload` contains `parent_thread_id`, `forked_from_id`, or `agent_path` are fork/subagent threads and do not enter the MVP list (3 exist locally). Later they could be attached to the parent session as “related sessions”.
- **Title**: `thread_name` from `{id, thread_name, updated_at}` in `~/.codex/session_index.jsonl`. When missing, take the first “real user text”: skip injected blocks such as `<environment_context>`, `<recommended_plugins>`, `<user_instructions>`, `<bridge_context>`; if there is no usable user text, fall back to the first assistant text, then to `未命名会话 · <first 8 chars of id>`.
- **Metadata**: `payload` of the first line with `type === "session_meta"`: `id` / `session_id`, `cwd`, `timestamp`.
- **Messages**: only `type === "response_item"` with `payload.type === "message"`:
  - `payload.role === "user" | "assistant"`; skip `developer` (injected instructions).
  - Take `text` from `payload.content[]` entries whose `type` is `input_text` / `output_text` / `text`.
  - Skip an entire user message when it consists only of the synthetic tags above.
- **Tools**:
  - `payload.type === "function_call"` → `{id, name, arguments (JSON string)}`
  - `payload.type === "custom_tool_call"` → `{id, name, input}`
  - `function_call_output` / `custom_tool_call_output` → associated by `call_id`
  - `reasoning` → thinking, collapsed
- **Ignored**: `event_msg` (its `item_completed` / `task_complete` duplicate response_item), `world_state`, `turn_context`, `token_usage_record` (token usage may optionally come from `payload.usage.total_tokens`).
- **Note**: the rollout file of a session is append-only, so line order is time order.

### 5.3 dsh (dsh-lark-channel)

- **Files**: `~/.dsh/sessions/<project-slug>/<sessionDir>/session.v4.jsonl.zstd`
  - Decompress with `zlib.zstdDecompressSync` and parse line by line.
  - `<sessionDir>` looks like `session-<uuid>`, `lark-oc_<chatId>`, `lark-oc_<chatId>--<hash>`.
- **Metadata**: `{id, createdAt, cwd}` from the first line with `type === "session"`; every line's event carries `time` (milliseconds).
- **Title**: the last `data.title` of `type === "session/title"`; otherwise the text of the first `user/message`.
- **Messages**:
  - `user/message` → `data.content[].text` (role=user)
  - `assistant/message` → `data.message.content[]`, blocks with `type` `text` / `reasoning`
  - `system/message`, `developer/message` → not displayed by default (collapsible system)
- **Tools**:
  - `tool/call` → `{callId, name, arguments (JSON string)}`
  - `tool/result` → `toolCallId` + `message.content[].text`, associated by `toolCallId`
- **Ignored**: internal events such as `step/start`, `step/end`, `turn/start`, `turn/end`, `request/*`, `job/*`, `agent/inbox/spliced`, `approval/*`, `todo/write`, `workspace/changes` (usable later for status display).
- **Optional statistics**: read `~/.dsh/storages/session_projcache/sessions/<id>.json` (version 7) for `record.identity.createdAt/cwd`, `record.rows.sessionStats.val`, and `record.rows.tokenMeasurement.val.anchor.usage.totalTokens`; absence does not affect the main flow.

### 5.4 Feishu chat mapping (chatId)

- **Claude / Codex**: read `~/.lark-channel/profiles/<agent>/sessions.json.catalog.json` (a JSON array). An element looks like:
  ```json
  {"scopeId":"oc_...","agentId":"claude","cwdRealpath":"/path","status":"active","sessionId":"..."}
  ```
  Codex elements use `threadId` instead of `sessionId`. Build a `nativeId → {scopeId, cwd}` mapping.
  Optionally also read `sessions.json` in the same directory (`chatId → {sessionId, cwd, updatedAt}`) as a supplement.
- **dsh**: extract from the session directory name: `/^lark-(oc_[A-Za-z0-9]+)/` → chatId.
- Sessions with no matched chatId (started directly in a terminal) display as “本地会话”.

### 5.5 Unified model

```ts
type Agent = 'claude' | 'codex' | 'dsh';

interface SessionMeta {
  key: string;              // `${agent}:${nativeId}`
  agent: Agent;
  nativeId: string;
  title: string;
  cwd: string | null;
  chatId: string | null;    // Feishu chat/topic scope id
  createdAt: number | null; // epoch ms
  updatedAt: number;        // epoch ms (file mtime fallback)
  sourcePath: string;
  archived: boolean;
  messageCount: number;
  tokens?: number | null;
  warnings?: string[];
}

interface ToolCall { id: string; name: string; input: unknown }

interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system';
  at: number | null;        // epoch ms
  text: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: { callId: string; output: string; isError?: boolean }[];
}
```

The `nativeId` inside `key` is `encodeURIComponent`-encoded and decoded again in the API.

## 6. SQLite copy and sync

The service maintains its own structured copy; **the source directories stay read-only at all times**, and all writes happen only in the application's own data directory.

### 6.1 Database location and settings

- Defaults to `~/.session-hub/hub.db` (directory and file created by this application), overridable with `SESSION_HUB_DB`.
- Uses `DatabaseSync` from Node's built-in `node:sqlite`; no external dependencies.
- After connecting, execute:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  ```
- Source files are the single source of truth; the DB can be deleted and rebuilt at any time.

### 6.2 Schema

```sql
CREATE TABLE sessions (
  key          TEXT PRIMARY KEY,          -- agent:nativeId
  agent        TEXT NOT NULL,             -- claude | codex | dsh
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

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,           -- order within the session
  role        TEXT NOT NULL,              -- user | assistant | tool | system
  at          INTEGER,
  text        TEXT NOT NULL DEFAULT '',
  thinking    TEXT,
  UNIQUE(session_key, seq)
);

CREATE TABLE tool_calls (
  id          INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  message_seq INTEGER NOT NULL,
  call_id     TEXT,
  name        TEXT,
  input_json  TEXT
);

CREATE TABLE tool_results (
  id          INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  message_seq INTEGER NOT NULL,
  call_id     TEXT,
  output      TEXT,
  is_error    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_state (
  source_path   TEXT PRIMARY KEY,
  mtime_ms      REAL NOT NULL,
  size          INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL
);

-- Full-text search: trigram suits Chinese substrings; verified on local SQLite 3.54.1
CREATE VIRTUAL TABLE messages_fts USING fts5(
  session_key UNINDEXED,
  seq UNINDEXED,
  body,
  tokenize = 'trigram'
);
```

- Indexes: `sessions(agent, updated_at DESC)`, `sessions(chat_id)`, `messages(session_key, seq)`, and `(session_key)` on both tool tables.
- `messages_fts.body` = the message's `text + thinking` (user / assistant only), maintained inside the write transaction; a resync deletes by `session_key` and re-inserts.
- **Short queries**: trigram requires at least 3 characters, so a two-character Chinese word (such as “会话”) would match 0 rows. When `q` is shorter than 3 characters, degrade to `LIKE '%q%'`; at ≥ 3 use FTS.

### 6.3 Sync flow

1. **Scan**: walk the file lists of all three sources (§5).
2. **Compare**: `stat` each file and compare against `mtime_ms` / `size` in `sync_state`; skip unchanged files.
3. **Parse**: read the full transcript (metadata, messages, tool results) only for changed files.
4. **Write**: inside a single transaction
   - `DELETE FROM sessions WHERE source_path = ?` (foreign keys cascade to messages and tools)
   - `DELETE FROM messages_fts WHERE session_key = ?`
   - insert the new `sessions` / `messages` / `tool_calls` / `tool_results` / `messages_fts`
   - upsert `sync_state`
5. **Cleanup**: delete sessions whose source files disappeared, along with their `sync_state` rows.
6. **State**: keep `{ scanning, lastSyncAt, warnings[] }` in memory for `/api/health`.

- **First sync**: about 188MB for Claude, run in the background; if the DB already has data the API is usable immediately and the UI refreshes once the sync completes.
- **Incremental**: every 5s in the background, `stat` only, and parse only what changed.
- **Rebuild**: `npm start -- --rebuild` clears every table and rescans everything.
- **Single-file failure**: record a warning, keep the old data, and do not block other files.

### 6.4 Reads

- `/api/sessions` and `/api/session` read the DB only; they never parse source files on demand.
- Frontend: the list polls every 5s; the detail view polls every 3s and repaints only when `messageCount` / `updatedAt` change.

## 7. Server API

Everything returns JSON (UTF-8); errors return `{error}` with a 4xx/5xx status.

| Method | Path | Description |
|---|---|---|
| GET | `/api/sessions?agent=&chat=&cwd=&q=&since=&limit=` | Session list + facets; `q` is a case-insensitive substring search |
| GET | `/api/session?key=<agent:nativeId>` | Metadata + messages ordered by time |
| GET | `/api/facets` | Count per agent, chatId list, cwd list |
| GET | `/api/health` | `{ok, scanning, sessions, warnings}` |
| GET | `/` and static assets | Served from `public/` |

- Search scope: user / assistant text and thinking (not tool output, to avoid noise and index bloat). `q` of ≥ 3 characters uses FTS5 trigram; 1–2 characters use `LIKE` (see §6.2).
- A file that fails to parse goes into `warnings` and does not affect other sessions.
- The session list is sorted by `updatedAt` descending by default.

## 8. UI

Single page, Chinese interface, no build step (vanilla HTML/CSS/JS).

```
┌ Session Hub ───────────────────────────────────────────────┐
│ [全部 132] [Claude 102] [Codex 21] [dsh 16]   🔍 搜索…      │
├──────────────────────────┬──────────────────────────────────┤
│ ● Claude  开发 A 股模拟盘…│  Claude · 2026-11-23 18:02        │
│   飞书·oc_39f8… · 2h 前   │  cwd: ~/Codex/simstock            │
│   128 条 · ~/Codex/home…  │  飞书会话: oc_39f8…  [复制]       │
│ ─────────────────────────│ ─────────────────────────────────│
│ ● Codex   检查构建失败…   │  用户  18:02                      │
│   本地会话 · 5h 前        │  这个项目为什么构建失败？          │
│   64 条 · ~/Codex/home…   │                                  │
│ ─────────────────────────│  助手  18:02                      │
│ ● dsh     扩展这个库…     │  我先看一下…                      │
│   飞书·oc_5626… · 1d 前   │  ▸ 工具 exec_command (折叠)       │
│   40 条 · ~/Documents/…   │  ...                             │
└──────────────────────────┴──────────────────────────────────┘
```

- Top bar: agent filter chips (with counts) + search box; chips and search persist in the URL hash / query.
- Left column: title, agent color dot, chatId (full or on hover), relative time, shortened cwd, message count.
- Right column:
  - Header metadata: agent, time range, cwd, chatId (copyable), message count, tokens (if present).
  - user / assistant use different background colors; assistant thinking and each tool call/result collapse inside `<details>`; tool arguments and results in a monospace font, truncated when long and expandable.
  - Scroll-to-bottom button.
- URL: `#/s/<key>` opens a session directly; it is restored after refresh.
- Empty state: “没有匹配的会话”; show progress while scanning.

## 9. Configuration

| Environment variable | Default | Description |
|---|---|---|
| `SESSION_HUB_HOST` | `127.0.0.1` | Bind address |
| `SESSION_HUB_PORT` | `7317` | Port |
| `SESSION_HUB_DB` | `~/.session-hub/hub.db` | Path of our own SQLite copy |
| `CLAUDE_HOME` | `~/.claude` | Claude data root (read-only) |
| `CODEX_HOME` | `~/.codex` | Codex data root (read-only) |
| `DSH_HOME` | `~/.dsh` | dsh data root (read-only) |
| `LARK_CHANNEL_HOME` | `~/.lark-channel` | Bridge state root (read-only catalogs) |

Startup flag `--rebuild`: clear the DB and rescan everything.

Startup output: `Session Hub → http://127.0.0.1:7317`.

## 10. File layout

```
ai-agent-session-hub/
├── package.json          # type: module; scripts: start / test
├── README.md
├── src/
│   ├── index.js          # entry: config + open DB + first sync + server
│   ├── config.js
│   ├── server.js         # node:http routing + static files
│   ├── db.js             # node:sqlite connection, schema, read/write helpers
│   ├── schema.sql        # tables / indexes / FTS
│   ├── sync.js           # scan, mtime comparison, parse, transactional writes, cleanup
│   ├── normalize.js      # unified model & text cleanup/titles
│   └── sources/
│       ├── claude.js
│       ├── codex.js
│       ├── dsh.js
│       └── larkMap.js
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── test/
│   ├── claude.test.js
│   ├── codex.test.js
│   ├── dsh.test.js
│   ├── lark-map.test.js
│   └── fixtures/         # small, redacted samples trimmed from real data
└── docs/superpowers/specs/2026-11-23-session-hub-design.md
```

Each source module exports:

```js
export async function discover(config, state) // returns a file list + metadata
export async function parseSession(file, meta) // returns Message[]
```

## 11. Security and privacy

- Bind only to `127.0.0.1` with no authentication; the docs and the page state clearly that this is for local use.
- Make no external network requests.
- **Never write to any source directory**: source files are opened read-only; all structured copies and indexes are written only to `~/.session-hub/hub.db`.
- Transcripts may contain secrets or private content: the README says not to expose the service to the public internet and not to share screenshots.

## 12. Testing and acceptance

### Automated

- `node:test` + `node:assert`, zero dependencies.
- One fixture per parser (10–30 lines trimmed from real sessions and redacted), asserting:
  - title, cwd, chatId, message order
  - association of text / thinking / tool calls with their results
  - unknown events are skipped without throwing
- `lark-map`: the three catalog shapes + the dsh directory-name regex.
- `sync` / `db`: temp DB + temp source directories, verifying:
  - the first sync writes correctly;
  - unchanged files are not rewritten (idempotent);
  - appending to a file updates only that session;
  - deleting a source file cleans up the corresponding rows;
  - queries of ≥3 characters use FTS and 1–2 characters use LIKE, with consistent results.
- Server integration: temp directory + fake data → request `/api/sessions` and `/api/session` and validate the JSON.

### Manual acceptance

1. `npm start` prints the URL and the browser can open it.
2. List counts follow the “user-visible sessions” rules: Claude counts only top-level UUID sessions (52 at the time, excluding 51 subagent transcripts); Codex excludes forks carrying `parent_thread_id` / `agent_path` (21 − 3 = 18 at the time); dsh counts all (16 at the time). Counts grow with use; the rules are what matters.
3. agent chips, chat, cwd, and search filters all work.
4. Open any session; message order and tool collapsing are correct.
5. Appending a line to the end of a session file updates the list/detail within 5s.
6. `~/.session-hub/hub.db` is created normally; deleting it and restarting rebuilds it completely; source directory contents and mtimes are untouched (proving read-only behavior).
7. `npm test` is all green.

## 13. Decisions left to the builder

- Concrete visual style and palette.
- Whether search extends to tool output (default: no).
- Chunked reading / truncation strategy for large files (>20MB).
- FTS maintenance approach (manual inside the write transaction vs triggers), WAL checkpoint timing, whether `VACUUM` is needed.
- Whether archived sessions are shown by default or collapsed.
- Whether subagent / fork transcripts (Claude `agent-*.jsonl` and `<sessionId>/subagents/`, Codex rollouts with `parent_thread_id`) should be attached to the parent session as “related sessions”; the MVP excludes them all.
