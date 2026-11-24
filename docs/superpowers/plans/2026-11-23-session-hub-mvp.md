# Session Hub — Read-Only Session Aggregation MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a zero-dependency, read-only web dashboard on the local machine that structurally syncs sessions from three sources — Claude, Codex, and dsh — into our own SQLite copy, and supports browsing, filtering, and full-text search.

**Architecture:** Node built-in HTTP server + `node:sqlite` database + vanilla frontend. Three source modules read and parse their own formats read-only; `sync.js` incrementally syncs into `~/.session-hub/hub.db` based on mtime/size; the HTTP API reads from the DB only; the frontend refreshes by polling.

**Tech Stack:** Node.js ≥ 22.5 (local machine v26.13.1), `node:http`, `node:fs/promises`, `node:zlib` (zstd), `node:sqlite`, vanilla HTML/CSS/JS; zero runtime dependencies; `node:test` tests.

**Spec:** `docs/superpowers/specs/2026-11-23-session-hub-design.md`

## Global Constraints

- Node.js ≥ 22.5; use the built-in `node:sqlite` and `node:zlib`; do not add any `dependencies`.
- Source directories are strictly read-only: open files for reading only; all application writes happen only in `SESSION_HUB_DB` (default `~/.session-hub/hub.db`).
- The server binds only to `127.0.0.1`, default port `7317`.
- UI copy is in Chinese.
- Subagent / fork transcripts do not enter the session list (Claude `agent-*.jsonl`, `<sessionId>/subagents/`; Codex rollouts carrying `parent_thread_id` / `forked_from_id` / `agent_path`).
- Search: queries ≥ 3 characters use FTS5 `trigram`; 1–2 characters use `LIKE '%q%'`.
- Run the task's tests and commit before finishing each task; tests must not write to the real source directories.

## Review Focus

- A session file is being appended to and its last JSON line is incomplete: the parser should skip that line and continue, and must not throw or drop the whole session. Tests live in Task 5 / 6 / 7.
- A single tool result is especially large (hundreds of KB to several MB): parsing, storing, and reading it back must not crash, and the UI collapses it by default. Tests live in Task 2 / 5.
- A source root directory is missing or unreadable: the app must still start and serve the other sources, producing only a warning. Tests live in Task 9.
- The bridge catalog is missing or corrupt: sessions must still be listed, with `chatId` as `null`. Tests live in Task 8 / 9.
- Time fields come in four shapes — ISO string, seconds, milliseconds, `null`: normalize them uniformly to milliseconds or `null`, never producing `NaN`. Tests live in Task 4.

---

### Task 1: Project skeleton and configuration

**Files:**
- Create: `package.json`, `.gitignore`, `src/config.js`, `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env, argv = process.argv.slice(2)) -> Config`
  ```ts
  Config = {
    host: string; port: number; dbPath: string; rebuild: boolean;
    roots: { claude: string; codex: string; dsh: string; larkChannel: string }
  }
  ```

- [ ] **Step 1: Initialize the repository and package skeleton**

`package.json`:
```json
{
  "name": "ai-agent-session-hub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.5" },
  "scripts": { "start": "node src/index.js", "test": "node --test" }
}
```

`.gitignore`:
```
node_modules/
*.db
*.db-wal
*.db-shm
.DS_Store
```

```bash
git init -b main
git checkout -b feat/session-hub-mvp
git add package.json .gitignore docs
git commit -m "chore: scaffold node esm project"
```

- [ ] **Step 2: Write the failing configuration tests**

`test/config.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('defaults', () => {
  const c = loadConfig({}, []);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 7317);
  assert.equal(c.rebuild, false);
  assert.equal(c.dbPath, path.join(os.homedir(), '.session-hub', 'hub.db'));
  assert.equal(c.roots.claude, path.join(os.homedir(), '.claude'));
  assert.equal(c.roots.codex, path.join(os.homedir(), '.codex'));
  assert.equal(c.roots.dsh, path.join(os.homedir(), '.dsh'));
  assert.equal(c.roots.larkChannel, path.join(os.homedir(), '.lark-channel'));
});

test('environment overrides and --rebuild', () => {
  const c = loadConfig({
    SESSION_HUB_HOST: '0.0.0.0',
    SESSION_HUB_PORT: '9000',
    SESSION_HUB_DB: '/tmp/hub.db',
    CLAUDE_HOME: '/c', CODEX_HOME: '/x', DSH_HOME: '/d', LARK_CHANNEL_HOME: '/l'
  }, ['--rebuild']);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 9000);
  assert.equal(c.dbPath, '/tmp/hub.db');
  assert.equal(c.rebuild, true);
  assert.deepEqual(c.roots, { claude: '/c', codex: '/x', dsh: '/d', larkChannel: '/l' });
});

test('invalid port falls back to the default', () => {
  assert.equal(loadConfig({ SESSION_HUB_PORT: 'abc' }, []).port, 7317);
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `node --test test/config.test.js`
Expected: FAIL, `Cannot find module .../src/config.js`

- [ ] **Step 4: Implement `src/config.js`**

Export `loadConfig(env, argv)`: read the environment variables from the table above; parse `SESSION_HUB_PORT` with `Number()` and validate it with `Number.isFinite`, falling back to `7317` when invalid; `rebuild = argv.includes('--rebuild')`; derive default paths with `os.homedir()` + `path.join`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test test/config.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: config loader with env overrides"
```

---

### Task 2: SQLite schema and writes

**Files:**
- Create: `src/schema.sql`, `src/db.js`, `test/db.test.js`

**Interfaces:**
- Produces:
  ```ts
  openDb(dbPath: string): DatabaseSync
  initSchema(db): void
  replaceSession(db, session: SessionRow, messages: Message[], sync: { mtimeMs: number; size: number }): void
  getSyncState(db, sourcePath: string): { mtimeMs: number; size: number } | null
  hasSession(db, key: string): boolean
  pruneMissing(db, keepPaths: Set<string>): number
  clearAll(db): void
  SessionRow = { key, agent, nativeId, title, cwd, chatId, createdAt, updatedAt,
                 sourcePath, archived, messageCount, tokens, extraJson }
  Message = { role, at?, text?, thinking?, toolCalls?: {id,name,input}[],
              toolResults?: {callId,output,isError?}[] }
  ```

- [ ] **Step 1: Write `src/schema.sql`**

Use the DDL from §6.2 of the design document, with `IF NOT EXISTS` on every `CREATE` (including `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts`), so `initSchema` can be called repeatedly. Add the indexes at the end of the file:
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_agent_updated ON sessions(agent, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_key, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_key);
CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_key);
```

- [ ] **Step 2: Write the failing DB tests**

`test/db.test.js` uses `openDb(':memory:')`:
```js
test('replaceSession writes the session, messages, tools, and sync_state', () => {
  const session = { key:'claude:s1', agent:'claude', nativeId:'s1', title:'T',
    cwd:'/p', chatId:null, createdAt:1, updatedAt:2, sourcePath:'/p/s1.jsonl',
    archived:0, messageCount:2, tokens:null, extraJson:null };
  const messages = [
    { role:'user', at:1, text:'hi' },
    { role:'assistant', at:2, text:'yo', thinking:'think',
      toolCalls:[{id:'c1',name:'bash',input:{cmd:'ls'}}],
      toolResults:[{callId:'c1',output:'ok'}] }
  ];
  replaceSession(db, session, messages, { mtimeMs:10, size:100 });
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM messages').get().c, 2);
  assert.equal(db.prepare('SELECT count(*) c FROM tool_calls').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM tool_results').get().c, 1);
  assert.deepEqual({ ...getSyncState(db, '/p/s1.jsonl') }, { mtimeMs:10, size:100 });
  assert.equal(hasSession(db, 'claude:s1'), true);
});

test('re-replacing a session replaces old messages and leaves no orphans', () => {
  // write 1 more message for the same sourcePath
  // assert messages/tool_calls/tool_results counts become 1/0/0
});

test('pruneMissing deletes sessions and sync_state rows not in keepPaths', () => {
  // pruneMissing(db, new Set(['/other'])) -> sessions 0, sync_state 0
});

test('oversized tool results can be stored and read back', () => {
  // output = 'x'.repeat(300 * 1024); assert tool_results.output.length is unchanged
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `node --test test/db.test.js`
Expected: FAIL, `Cannot find module .../src/db.js`

- [ ] **Step 4: Implement `src/db.js`**

- `openDb(dbPath)`: `new DatabaseSync(dbPath)`, then execute the PRAGMAs from §6.1.
- `initSchema(db)`: read `new URL('./schema.sql', import.meta.url)` and `db.exec()` it.
- `replaceSession`: `db.exec('BEGIN')` → `DELETE FROM messages_fts WHERE session_key = ?` → `DELETE FROM sessions WHERE source_path = ?` (or delete by key) → insert session/messages/tools/FTS → upsert `sync_state` → `COMMIT`; on error `ROLLBACK` and rethrow.
  - `messages.seq` increments from 0; `tool_calls.message_seq` / `tool_results.message_seq` point at the owning message's `seq`.
  - `messages_fts` gets one row per user/assistant message, with `body` assembled in JS as `text + '\n' + (thinking ?? '')`, avoiding SQL `NULL` propagation.
  - Store `archived` as `0/1`.
- `pruneMissing(db, keepPaths)`: inside a transaction, delete sessions and sync_state rows whose `source_path NOT IN keepPaths` (use a temp table or batched `SELECT` + `DELETE`); return the number deleted.
- `clearAll(db)`: inside a transaction, clear `messages_fts`, `tool_results`, `tool_calls`, `messages`, `sessions`, `sync_state` in that order.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test test/db.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/schema.sql src/db.js test/db.test.js
git commit -m "feat: sqlite schema and transactional session writes"
```

---

### Task 3: Queries, detail, and search

**Files:**
- Modify: `src/db.js`
- Test: `test/db-query.test.js`

**Interfaces:**
- Produces:
  ```ts
  listSessions(db, q: { agent?, chat?, cwd?, q?, limit?, includeArchived? }): SessionRow[]
  getSession(db, key: string): { session: SessionRow, messages: Message[] } | null
  getFacets(db): { agents: {agent,count}[], chats: {chatId,count}[], cwds: {cwd,count}[] }
  ```

- [ ] **Step 1: Write the failing query tests**

`test/db-query.test.js`: use a helper to write 3 sessions:
- `claude:a`, chat `oc_A`, cwd `/p1`, updated 300, with a message containing 「这个项目为什么构建失败」
- `codex:b`, chat `oc_B`, cwd `/p2`, updated 200, with a message containing 「会话聚合」
- `dsh:c`, chat null, cwd `/p1`, updated 100

Assertions:
```js
assert.deepEqual(listSessions(db, {}).map(s => s.key), ['claude:a','codex:b','dsh:c']); // updated_at DESC
assert.deepEqual(listSessions(db, { agent:'codex' }).map(s => s.key), ['codex:b']);
assert.deepEqual(listSessions(db, { chat:'oc_A' }).map(s => s.key), ['claude:a']);
assert.deepEqual(listSessions(db, { cwd:'/p1' }).map(s => s.key), ['claude:a','dsh:c']); // updated DESC
assert.deepEqual(listSessions(db, { q:'构建失败' }).map(s => s.key), ['claude:a']);   // 4 characters -> FTS
assert.deepEqual(listSessions(db, { q:'会话' }).map(s => s.key), ['codex:b']);        // 2 characters -> LIKE
assert.equal(listSessions(db, { limit: 2 }).length, 2);
const detail = getSession(db, 'claude:a');
assert.equal(detail.messages.length, 2);
assert.equal(detail.messages[1].toolCalls[0].name, 'bash');
assert.equal(detail.messages[1].toolResults[0].output, 'ok');
assert.equal(getSession(db, 'nope'), null);
const facets = getFacets(db);
assert.deepEqual(facets.agents.map(a => a.agent).sort(), ['claude','codex','dsh']);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/db-query.test.js`
Expected: FAIL, `listSessions is not a function`

- [ ] **Step 3: Implement the query functions**

- `listSessions`: build the WHERE clause dynamically (bind every filter value as a parameter; never concatenate strings). When `q.length >= 3`, use `session_key IN (SELECT session_key FROM messages_fts WHERE body MATCH ?)` with the query wrapped in double quotes and internal double quotes escaped (`'"' + q.replaceAll('"','""') + '"'`) to avoid FTS syntax errors; otherwise use `session_key IN (SELECT session_key FROM messages WHERE text LIKE ? ESCAPE '\' OR thinking LIKE ? ESCAPE '\')` with `%q%` where `%`/`_` are escaped. Default `includeArchived = true`; sort by `updated_at DESC`; `limit` defaults to 500; convert each row's `archived` to a boolean.
- `getSession`: fetch the session row; fetch messages ordered by `seq`; fetch tool_calls/tool_results by `message_seq` and assemble them back into Message; convert `archived` to a boolean.
- `getFacets`: `GROUP BY` each of the three dimensions, filtering out NULL chat/cwd.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/db-query.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db-query.test.js
git commit -m "feat: session queries, detail and fts search"
```

---

### Task 4: Text and time normalization

**Files:**
- Create: `src/normalize.js`
- Test: `test/normalize.test.js`

**Interfaces:**
- Produces:
  ```ts
  textFromContent(content: string | Block[] | null): string
  stripBridgeContext(text: string): string
  isSyntheticUserText(text: string): boolean
  deriveTitle(text: string, fallback?: string): string
  toEpochMs(value: unknown): number | null
  truncate(text: string, n: number): string
  ```

- [ ] **Step 1: Write the failing normalization tests**

```js
test('textFromContent concatenates text blocks', () => {
  assert.equal(textFromContent('hi'), 'hi');
  assert.equal(textFromContent([{type:'text',text:'a'},{type:'tool_use'},{type:'text',text:'b'}]), 'a\nb');
  assert.equal(textFromContent([{type:'input_text',text:'q'},{type:'output_text',text:'a'}]), 'q\na');
  assert.equal(textFromContent(null), '');
});

test('stripBridgeContext and synthetic text detection', () => {
  const t = '<bridge_context>{"chatId":"oc_1"}</bridge_context>\n你好';
  assert.equal(stripBridgeContext(t), '你好');
  assert.equal(isSyntheticUserText('<environment_context>...</environment_context>'), true);
  assert.equal(isSyntheticUserText('<recommended_plugins>x</recommended_plugins>'), true);
  assert.equal(isSyntheticUserText('你好'), false);
});

test('deriveTitle takes the first line and truncates', () => {
  assert.equal(deriveTitle('第一行\n第二行'), '第一行');
  assert.equal(deriveTitle('<bridge_context>{}</bridge_context>\n检查构建'), '检查构建');
  assert.equal(deriveTitle('', '未命名会话'), '未命名会话');
  assert.equal(deriveTitle('x'.repeat(200)).length, 80);
});

test('toEpochMs handles the four shapes', () => {
  assert.equal(toEpochMs('2026-11-01T00:00:00.000Z'), Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(toEpochMs(1795000000), 1795000000000);       // seconds
  assert.equal(toEpochMs(1795000000000), 1795000000000);    // milliseconds
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs('not a date'), null);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/normalize.test.js`
Expected: FAIL, module does not exist

- [ ] **Step 3: Implement `src/normalize.js`**

- `stripBridgeContext`: remove with the regex `/<bridge_context>[\s\S]*?<\/bridge_context>/g`, then `trim()`.
- `isSyntheticUserText`: after trimming and dropping a BOM, match `^<(environment_context|recommended_plugins|user_instructions|local-command-caveat|local-command-stdout|command-name)\b`.
- `deriveTitle`: `stripBridgeContext` → first non-empty line → `truncate(80)`; fall back when empty.
- `toEpochMs`: a number `< 1e12` is treated as seconds ×1000; strings go through `Date.parse`; invalid or null returns null.
- `textFromContent`: a string is returned as-is; for arrays, take `text` from blocks whose `type` is `text` / `input_text` / `output_text`, joined with `\n`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/normalize.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/normalize.js test/normalize.test.js
git commit -m "feat: text and time normalization helpers"
```

---

### Task 5: Claude source parsing

**Files:**
- Create: `src/sources/claude.js`, `test/sources-claude.test.js`, `test/fixtures/claude/session-1.jsonl`
- Modify: none

**Interfaces:**
- Produces:
  ```ts
  discoverClaude(config): Promise<DiscoveredFile[]>
  parseClaude(sourcePath: string, discovery?: DiscoveredFile): Promise<ParsedSession>
  DiscoveredFile = { agent, sourcePath, archived, mtimeMs, size, titleHint?, chatHint?, nativeId? }
  ParsedSession = { nativeId, title, cwd, createdAt, messages, tokens?, extra? }
  ```

- [ ] **Step 1: Write the fixture**

`test/fixtures/claude/session-1.jsonl` (one valid JSON object per line):
```jsonl
{"type":"queue-operation","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-11-01T00:00:00.000Z"}
{"type":"user","sessionId":"11111111-1111-4111-8111-111111111111","cwd":"/tmp/proj","timestamp":"2026-11-01T00:00:01.000Z","message":{"role":"user","content":"帮我检查构建失败"}}
{"type":"assistant","sessionId":"11111111-1111-4111-8111-111111111111","cwd":"/tmp/proj","timestamp":"2026-11-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先看日志"},{"type":"text","text":"我看一下。"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-11-01T00:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a.txt"}]}}
{"type":"attachment","timestamp":"2026-11-01T00:00:04.000Z"}
```

- [ ] **Step 2: Write the failing parser tests**

```js
const file = path.join(FIXTURES, 'claude/session-1.jsonl');
test('parseClaude extracts messages, thinking, and tool results', async () => {
  const p = await parseClaude(file);
  assert.equal(p.nativeId, '11111111-1111-4111-8111-111111111111');
  assert.equal(p.cwd, '/tmp/proj');
  assert.equal(p.title, '帮我检查构建失败');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[0].role, 'user');
  assert.equal(p.messages[1].text, '我看一下。');
  assert.equal(p.messages[1].thinking, '先看日志');
  assert.deepEqual(p.messages[1].toolCalls[0], { id:'toolu_1', name:'Bash', input:{command:'ls'} });
  assert.deepEqual(p.messages[1].toolResults[0], { callId:'toolu_1', output:'a.txt', isError:false });
});
test('skips an incomplete last line without throwing', async () => {
  // copy the fixture to a temp directory, append '{"type":"user","mess'
  // parseClaude -> still returns 2 messages
});
test('custom-title wins and subagent files are ignored', async () => {
  // temp dir: projects/p1/<uuid>.jsonl + p1/<uuid>/custom-title.json + agent-x.jsonl
  // discoverClaude -> returns only 1 file; parsed title uses customTitle
});
test('oversized tool results still parse', async () => {
  // build a 300KB tool_result line -> no throw
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `node --test test/sources-claude.test.js`
Expected: FAIL, module does not exist

- [ ] **Step 4: Implement `src/sources/claude.js`**

- `discoverClaude(config)`:
  - Walk the top-level `*.jsonl` under `${roots.claude}/projects/*/`; the basename must match `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/`; skip `agent-*`.
  - `stat` for mtimeMs/size; `nativeId` = name without `.jsonl`; if `<sessionId>/custom-title.json` exists, read `customTitle` as `titleHint`.
  - Return `[]` when the directory does not exist; do not throw.
- `parseClaude`: `JSON.parse` line by line, skipping failed lines (including the trailing partial line). Only handle entries whose `type` is `user`/`assistant`:
  - block `text` → text; `thinking` → `thinking`; `tool_use` → `toolCalls`; `tool_result` → attach to the message that contained the matching call, keyed by `tool_use_id` (maintain `callId -> messageIndex`).
  - Skip messages with no text, no thinking, and no tools.
  - Title: `discovery?.titleHint || deriveTitle(first real user text) || '未命名会话'`; real user text skips `isSyntheticUserText` entries.
  - `cwd`, `createdAt` come from the first entry carrying a value.
  - `nativeId` comes from the entry's `sessionId`, falling back to the filename.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test test/sources-claude.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/sources/claude.js test/sources-claude.test.js test/fixtures/claude
git commit -m "feat: claude transcript discovery and parser"
```

---

### Task 6: Codex source parsing

**Files:**
- Create: `src/sources/codex.js`, `test/sources-codex.test.js`, `test/fixtures/codex/rollout-1.jsonl`, `test/fixtures/codex/subagent.jsonl`, `test/fixtures/codex/session_index.jsonl`

**Interfaces:**
- Produces: `discoverCodex(config): Promise<DiscoveredFile[]>`, `parseCodex(sourcePath, discovery?): Promise<ParsedSession>`

- [ ] **Step 1: Write the fixtures**

`rollout-1.jsonl`:
```jsonl
{"type":"session_meta","payload":{"id":"22222222-2222-4222-8222-222222222222","cwd":"/tmp/codex","timestamp":"2026-11-01T00:00:00.000Z"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"检查构建失败"}]}}
{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"先看日志"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"我看一下。"}]}}
{"type":"response_item","payload":{"type":"function_call","id":"fc_toolu_1","call_id":"toolu_1","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"toolu_1","output":"a.txt"}}
```
`subagent.jsonl`: the first line's `session_meta.payload` carries `"parent_thread_id":"parent"`.
`session_index.jsonl`: `{"id":"22222222-2222-4222-8222-222222222222","thread_name":"检查构建","updated_at":"2026-11-01T00:00:05.000Z"}`

- [ ] **Step 2: Write the failing tests**

```js
test('parseCodex extracts messages, reasoning, and tools', async () => {
  const p = await parseCodex(rollout, { titleHint: '检查构建' });
  assert.equal(p.nativeId, '22222222-2222-4222-8222-222222222222');
  assert.equal(p.cwd, '/tmp/codex');
  assert.equal(p.title, '检查构建');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[1].thinking, '先看日志');
  assert.deepEqual(p.messages[1].toolCalls[0], { id:'toolu_1', name:'shell', input:{cmd:'ls'} });
  assert.deepEqual(p.messages[1].toolResults[0], { callId:'toolu_1', output:'a.txt', isError:false });
});
test('discoverCodex reads index titles and excludes subagents', async () => {
  // temp codex root: sessions/2026/11/01/rollout-1.jsonl + subagent.jsonl + session_index.jsonl
  const files = await discoverCodex({ roots: { codex: tmpRoot } });
  assert.equal(files.length, 1);
  assert.equal(files[0].titleHint, '检查构建');
});
test('falls back to the first real user text when the index is missing', async () => {
  // remove session_index.jsonl -> title === '检查构建失败'
});
test('a trailing partial line and unknown events are skipped', async () => {
  // append a partial line + {"type":"world_state"} -> still 2 messages
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `node --test test/sources-codex.test.js`
Expected: FAIL, module does not exist

- [ ] **Step 4: Implement `src/sources/codex.js`**

- `discoverCodex`: walk `${roots.codex}/sessions/**/rollout-*.jsonl` and `${roots.codex}/archived_sessions/*.jsonl` (archived=true). For each file, read only the first line and skip it when `payload.parent_thread_id || payload.forked_from_id || payload.agent_path` is present. Read `${roots.codex}/session_index.jsonl` into an `id → thread_name` map for `titleHint`. `nativeId` comes from `payload.id || payload.session_id || the UUID in the filename`.
- `parseCodex`: parse line by line; `session_meta` provides cwd/timestamp/nativeId; `response_item`:
  - `payload.type === 'message'` with role `user`/`assistant` → text via `textFromContent(content)`; skip `developer`; skip an entire user message when `isSyntheticUserText` is true.
  - `reasoning` → stash `summary[].text` and attach it as `thinking` of the next assistant message.
  - `function_call` / `custom_tool_call` → `{ id: payload.call_id || payload.id, name, input }` (try `JSON.parse` on `arguments`, keep the raw string on failure); attach `*_output` to the owning message by `call_id`; when the exact match fails, retry after stripping the `fc_` / `ctc_` prefixes.
  - Ignore `event_msg`, `world_state`, `turn_context`, `token_usage_record` (tokens may optionally come from `usage.total_tokens`).
  - Title: `titleHint || deriveTitle(first real user text) || '未命名会话 · ' + nativeId.slice(0,8)`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test test/sources-codex.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sources/codex.js test/sources-codex.test.js test/fixtures/codex
git commit -m "feat: codex rollout discovery and parser"
```

---

### Task 7: dsh source parsing

**Files:**
- Create: `src/sources/dsh.js`, `test/sources-dsh.test.js`

**Interfaces:**
- Produces: `discoverDsh(config): Promise<DiscoveredFile[]>`, `parseDsh(sourcePath, discovery?): Promise<ParsedSession>`

- [ ] **Step 1: Write the test helper and the failing tests**

helper: write an array of JSONL lines with `zlib.zstdCompressSync(Buffer.from(lines.join('\n')))` into a temp `<slug>/<sessionDir>/session.v4.jsonl.zstd`.

```js
test('parseDsh extracts metadata, title, messages, and tools', async () => {
  // lines: session / user/message / session/title / assistant/message (text+reasoning)
  //        / tool/call / tool/result / turn/end
  const p = await parseDsh(file);
  assert.equal(p.nativeId, 'session-33333333-3333-4333-8333-333333333333');
  assert.equal(p.cwd, '/tmp/dsh');
  assert.equal(p.title, '扩展这个库');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[1].thinking, '先读文档');
  assert.deepEqual(p.messages[1].toolCalls[0], { id:'tool-1', name:'read', input:{path:'README.md'} });
  assert.deepEqual(p.messages[1].toolResults[0], { callId:'tool-1', output:'# README', isError:false });
});
test('discoverDsh finds zstd sessions and extracts chatId from the directory name', async () => {
  // two sessions: session-xxx and lark-oc_ABC--hash
  // files.length === 2; the latter has chatHint === 'oc_ABC'
});
test('a missing projcache and a corrupt archive do not affect other sessions', async () => {
  // one bad .zstd (not zstd bytes) -> parse throws and the caller handles it; discover still lists it
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/sources-dsh.test.js`
Expected: FAIL, module does not exist

- [ ] **Step 3: Implement `src/sources/dsh.js`**

- `discoverDsh`: walk `${roots.dsh}/sessions/*/*/session.v4.jsonl.zstd`; `chatHint = /^lark-(oc_[A-Za-z0-9]+)/` matched against the directory name; `stat` for mtime/size.
- `parseDsh`: `zlib.zstdDecompressSync(await readFile(path))` → `split('\n')`, then parse line by line:
  - `session` → nativeId/id, cwd, createdAt
  - `user/message` → text (`data.content[].text`)
  - `assistant/message` → `data.message.content[]`, `text` / `reasoning`
  - `session/title` → overrides the title (take the last one)
  - `tool/call` → `{callId, name, arguments}`; `tool/result` → attach to the owning message by `toolCallId` (using callId→messageIndex)
  - `system/message` / `developer/message` are not displayed
  - other events are ignored
  - optional: if `${roots.dsh}/storages/session_projcache/sessions/<id>.json` exists, read `record.rows.tokenMeasurement.val.anchor.usage.totalTokens` as `tokens`
- Title fallback: `session/title` → first user text → `'未命名会话'`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/sources-dsh.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sources/dsh.js test/sources-dsh.test.js
git commit -m "feat: dsh zstd session discovery and parser"
```

---

### Task 8: Feishu chat mapping

**Files:**
- Create: `src/sources/larkMap.js`, `test/lark-map.test.js`

**Interfaces:**
- Produces:
  ```ts
  buildChatMap(config): Promise<Map<string, string>>   // key: `${agent}:${nativeId}` -> chatId
  chatIdFromDshDir(dirName: string): string | null
  ```

- [ ] **Step 1: Write the failing tests**

```js
test('reads the claude/codex catalogs and builds the mapping', async () => {
  // temp larkChannel root: profiles/claude/sessions.json.catalog.json
  //   [{scopeId:'oc_A',agentId:'claude',sessionId:'s1'}]
  // profiles/codex/sessions.json.catalog.json
  //   [{scopeId:'oc_B',agentId:'codex',threadId:'t1'}]
  const m = await buildChatMap({ roots: { larkChannel: tmp } });
  assert.equal(m.get('claude:s1'), 'oc_A');
  assert.equal(m.get('codex:t1'), 'oc_B');
});
test('a missing or corrupt catalog returns an empty map without throwing', async () => {
  // absent -> new Map(); write 'not json' -> new Map()
});
test('extracts chatId from a dsh directory name', () => {
  assert.equal(chatIdFromDshDir('lark-oc_ABC123'), 'oc_ABC123');
  assert.equal(chatIdFromDshDir('lark-oc_ABC123--800327b4cf'), 'oc_ABC123');
  assert.equal(chatIdFromDshDir('session-abc'), null);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/lark-map.test.js`
Expected: FAIL, module does not exist

- [ ] **Step 3: Implement `src/sources/larkMap.js`**

Read both catalogs (a `try/catch` swallows absence and parse errors); take `scopeId` and `sessionId || threadId` from each element and write them into the `Map`. `chatIdFromDshDir` uses `/^lark-(oc_[A-Za-z0-9]+)/`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/lark-map.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sources/larkMap.js test/lark-map.test.js
git commit -m "feat: map native sessions to feishu chat ids"
```

---

### Task 9: Sync orchestration

**Files:**
- Create: `src/sync.js`, `test/sync.test.js`

**Interfaces:**
- Produces:
  ```ts
  syncOnce(db, config, opts?: { chatMap?: Map<string,string>; force?: boolean }):
    Promise<{ added, updated, unchanged, removed, warnings: string[] }>
  ```

- [ ] **Step 1: Write the failing sync tests**

Build minimal data for all three sources in temp directories (reusing the fixture-generation logic from Tasks 5–7), with `openDb(':memory:')` + `initSchema`.

```js
test('the first sync writes sessions from all three sources', async () => {
  const r = await syncOnce(db, config);
  assert.equal(r.added, 3);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 3);
});
test('a second sync with no changes reports all unchanged', async () => {
  const r = await syncOnce(db, config);
  assert.deepEqual({ added:r.added, updated:r.updated, unchanged:r.unchanged, removed:r.removed },
                   { added:0, updated:0, unchanged:3, removed:0 });
});
test('appending content updates only the affected session', async () => {
  // append one user line to the claude fixture -> updated 1, that session's message_count +1
});
test('deleting a source file prunes the session', async () => {
  // unlink one file -> removed 1
});
test('a missing source root still completes and produces a warning', async () => {
  // all roots point at nonexistent paths -> no throw; warnings has at least one entry containing one of the paths; sessions 0
});
test('a missing source root does not wrongly delete existing sessions', async () => {
  // sync normally once; then point one root at a nonexistent path and sync again -> that source's old sessions remain, removed 0
});
test('a bad file does not block other sessions and keeps the old data', async () => {
  // replace one file with invalid content and bump its mtime -> warning, other sessions still sync
});
test('chatId is null when the catalog is missing', async () => {
  // no larkChannel root -> every chatId from listSessions is null
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/sync.test.js`
Expected: FAIL, module does not exist

- [ ] **Step 3: Implement `src/sync.js`**

1. `chatMap = opts.chatMap ?? await buildChatMap(config)`.
2. For each root, `stat` first: if it is missing or unreadable, push a warning (including the path) and treat that source as an empty list. Then `Promise.all([discoverClaude, discoverCodex, discoverDsh])`, wrapping each in `try/catch`; on failure push a warning and treat it as an empty list.
3. For each `DiscoveredFile`:
   - `getSyncState(db, sourcePath)`; unchanged and `!force` → `unchanged++`, skip.
   - `parseXxx` (dispatch by agent); on failure → warning, keep the old data.
   - Assemble the `SessionRow`: `key = agent + ':' + nativeId`; `chatId = chatMap.get(key) ?? file.chatHint ?? null`; `updatedAt = Math.floor(file.mtimeMs)`; `messageCount = messages.length`; `extraJson = JSON.stringify(parsed.extra ?? null)`.
   - Use `hasSession` to decide added/updated; `replaceSession(..., { mtimeMs, size })`.
4. Run `pruneMissing(db, new Set(all discovered paths))` → `removed` only when discovery succeeded for all three sources; skip pruning when any source root is missing or any discovery failed, so old sessions are never wrongly deleted.
5. Return the statistics and warnings.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/sync.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync.js test/sync.test.js
git commit -m "feat: incremental sync orchestrator"
```

---

### Task 10: HTTP API and static serving

**Files:**
- Create: `src/server.js`, `test/server.test.js`

**Interfaces:**
- Produces:
  ```ts
  createServer({ db, state, publicDir }): http.Server
  // state: { scanning: boolean; lastSyncAt: number|null; warnings: string[] }
  ```

- [ ] **Step 1: Write the failing API tests**

Write 2 sessions into a temp DB, `createServer(...).listen(0)`, then request with `fetch`:

```js
test('GET /api/sessions returns the list and facets', async () => {
  const res = await fetch(base + '/api/sessions');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessions.length, 2);
  assert.ok(Array.isArray(body.facets.agents));
});
test('filter and search parameters take effect', async () => {
  const body = await (await fetch(base + '/api/sessions?agent=claude')).json();
  assert.equal(body.sessions.length, 1);
  const s = await (await fetch(base + '/api/sessions?q=构建失败')).json();
  assert.equal(s.sessions.length, 1);
});
test('GET /api/session returns the detail; an unknown key is 404', async () => {
  const ok = await fetch(base + '/api/session?key=' + encodeURIComponent('claude:a'));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).messages.length, 2);
  assert.equal((await fetch(base + '/api/session?key=nope')).status, 404);
});
test('GET /api/health reports status', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.sessions, 2);
  assert.equal(h.scanning, false);
});
test('static files and path traversal protection', async () => {
  // use a temp publicDir containing an index.html with id="app"
  // GET / -> 200 text/html, body contains id="app"
  // GET /../package.json -> 404
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/server.test.js`
Expected: FAIL, module does not exist

- [ ] **Step 3: Implement `src/server.js`**

- Routes: `/api/health`, `/api/sessions`, `/api/session`, `/api/facets`; everything else is served from `publicDir` by path.
- Take `key` from the query, `decodeURIComponent` it, and pass it to `getSession`.
- Static: use `path.normalize` + `startsWith(publicDir + path.sep)` to prevent traversal; serve `index.html` for `/`; set `Content-Type` (`text/html; charset=utf-8`, `text/javascript`, `text/css`).
- Add `Cache-Control: no-store` to every response.
- Unknown API paths return 404 JSON; non-GET returns 405.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/server.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: json api and static file server"
```

---

### Task 11: Frontend dashboard

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: `/api/sessions`, `/api/session?key=`, `/api/facets`
- Produces: a static page with an `#app` container

- [ ] **Step 1: Write `public/index.html`**

Skeleton: a top filter area (`#agent-chips`, `#search`), the list on the left (`#session-list`), the detail on the right (`#session-detail`), and `#status`. Load `app.js` and `style.css`. Include `<div id="app">`.

- [ ] **Step 2: Write `public/style.css`**

Two-column layout (`display:grid; grid-template-columns: 360px 1fr`); agent color dots (claude purple, codex green, dsh blue); message bubbles; tool `<details>` in a monospace font; single column on narrow screens.

- [ ] **Step 3: Write `public/app.js`**

- State: `{ agent: 'all', q: '', selected: null }`, restored from `location.hash` / `localStorage`.
- `loadSessions()`: `fetch('/api/sessions?...')` → render chip counts and the list; poll every 5s.
- `openSession(key)`: `fetch('/api/session?key=...')` → render the detail; poll every 3s, repaint only when `updatedAt`/`messageCount` change.
- List items: title, agent, chatId (or “本地会话”), relative time, cwd, message count.
- Detail: metadata header + message stream; `thinking` and each tool call/result inside `<details>`; render text with `textContent` (XSS-safe).
- Search: 300ms debounce, written back to `location.hash`.
- Empty state, loading state, error messages.

- [ ] **Step 4: Manually verify the static page**

Run from the repository root:
```bash
node --input-type=module -e "
import { openDb, initSchema } from './src/db.js';
import { createServer } from './src/server.js';
const db = openDb(':memory:'); initSchema(db);
createServer({ db, state: { scanning:false, lastSyncAt:null, warnings:[] }, publicDir: process.cwd() + '/public' })
  .listen(7317, '127.0.0.1', () => console.log('http://127.0.0.1:7317'));
"
```

Open a browser and confirm the page loads with no console errors; an empty list shows the empty state.

- [ ] **Step 5: Commit**

```bash
git add public
git commit -m "feat: read-only session hub web ui"
```

---

### Task 12: Entry point, background sync, and README

**Files:**
- Create: `src/index.js`, `README.md`
- Modify: none

**Interfaces:**
- Consumes: `loadConfig`, `openDb` / `initSchema` / `clearAll`, `syncOnce`, `createServer`

- [ ] **Step 1: Implement `src/index.js`**

Flow:
1. `const config = loadConfig()`.
2. `mkdir(dirname(config.dbPath), { recursive: true })`.
3. `openDb` → `initSchema`; when `config.rebuild`, `clearAll(db)` and force the first sync.
4. `state = { scanning: true, lastSyncAt: null, warnings: [] }`.
5. Start an `http.Server` listening on `config.host:config.port` and print `Session Hub → http://host:port`.
6. `runSync()`: return immediately when `state.scanning` is true (re-entrancy guard); otherwise set `state.scanning = true` → `try { syncOnce } finally { state.scanning = false }`, update `lastSyncAt` and `warnings`; `setInterval(runSync, 5000)`.
7. `SIGINT`/`SIGTERM`: clear the timer, `server.close()`, `db.close()`, exit.

- [ ] **Step 2: Write `README.md`**

Include: purpose, the read-only statement, prerequisites (Node ≥ 22.5, the three local data sources), `npm start`, `--rebuild`, the environment variable table, data location `~/.session-hub/hub.db`, the privacy note (transcripts may contain secrets; never expose the service to the public internet), and the test command.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 4: Manual end-to-end acceptance**

```bash
npm start
```
Work through the manual acceptance checklist in §12 of the design document:
1. It prints the URL and the page opens.
2. Counts follow the rules: Claude top-level UUID sessions (52 at the time), Codex excluding forks (18 at the time), dsh (16 at the time).
3. agent / chat / cwd / search filters work.
4. Detail messages are in order and tools are collapsed correctly.
5. Appending a line to a session file updates within 5s.
6. `~/.session-hub/hub.db` is created; deleting it and restarting rebuilds it; source directory contents and mtimes are untouched.
7. `npm test` is all green.

- [ ] **Step 5: Commit**

```bash
git add src/index.js README.md
git commit -m "feat: entry point, background sync and docs"
```

---

## Self-check notes

- **Spec coverage**: configuration (Task 1), SQLite copy and schema (2–3), three-source parsing (5–7), chat mapping (8), incremental sync (9), API (10), UI (11), entry point/rebuild/README (12), read-only and security (global constraints + 12).
- **Type consistency**: `DiscoveredFile` / `ParsedSession` / `SessionRow` / `Message` are defined in Task 2 and later tasks reference the same field names; `listSessions` / `getSession` / `getFacets` match the server.
- **Review Focus mapping**: partial JSON lines (5/6/7), oversized tool results (2/5), missing source roots (9), corrupt catalogs (8/9), time shapes (4).
