# Session Hub —— 只读会话聚合 MVP 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机运行一个零依赖的只读 Web 看板，把 Claude、Codex、dsh 三处会话结构化同步到自有 SQLite 副本，并支持浏览、过滤与全文搜索。

**Architecture:** Node 内置 HTTP 服务 + `node:sqlite` 数据库 + 原生前端。三个 source 模块只读解析各自格式，`sync.js` 按 mtime/size 增量同步进 `~/.session-hub/hub.db`，HTTP API 只读 DB，前端轮询刷新。

**Tech Stack:** Node.js ≥ 22.5（本机 v26.13.1）、`node:http`、`node:fs/promises`、`node:zlib`（zstd）、`node:sqlite`、原生 HTML/CSS/JS；零运行时依赖；`node:test` 测试。

**Spec:** `docs/superpowers/specs/2026-11-23-session-hub-design.md`

## Global Constraints

- Node.js ≥ 22.5；使用内置 `node:sqlite`、`node:zlib`，不新增任何 `dependencies`。
- 源目录严格只读：只以读取方式打开文件；应用所有写入只发生在 `SESSION_HUB_DB`（默认 `~/.session-hub/hub.db`）。
- 服务只绑定 `127.0.0.1`，默认端口 `7317`。
- 界面文案使用中文。
- 子代理 / fork transcript 不进入会话列表（Claude `agent-*.jsonl`、`<sessionId>/subagents/`；Codex 带 `parent_thread_id` / `forked_from_id` / `agent_path` 的 rollout）。
- 搜索：查询 ≥ 3 字符走 FTS5 `trigram`；1–2 字符走 `LIKE '%q%'`。
- 每个任务结束前运行该任务的测试并提交；测试不得写入真实源目录。

## Review Focus

- 会话文件正在被追加、最后一行 JSON 不完整：解析器应跳过该行并继续，不得抛错或丢弃整个会话。测试放在 Task 5 / 6 / 7。
- 单条工具结果特别大（数百 KB 到数 MB）：解析、入库、读回都不应崩溃，UI 默认折叠。测试放在 Task 2 / 5。
- 某个源根目录不存在或不可读：应用仍能启动并提供其它来源，只产生 warning。测试放在 Task 9。
- bridge 的 catalog 缺失或损坏：会话仍需列出，`chatId` 为 `null`。测试放在 Task 8 / 9。
- 时间字段存在 ISO 字符串、秒、毫秒、`null` 四种形态：统一归一为毫秒或 `null`，不得产生 `NaN`。测试放在 Task 4。

---

### Task 1: 项目骨架与配置

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

- [ ] **Step 1: 初始化仓库与包骨架**

`package.json`：
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

`.gitignore`：
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

- [ ] **Step 2: 写失败的配置测试**

`test/config.test.js`：
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('默认值', () => {
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

test('环境变量覆盖与 --rebuild', () => {
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

test('非法端口回退默认值', () => {
  assert.equal(loadConfig({ SESSION_HUB_PORT: 'abc' }, []).port, 7317);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL，`Cannot find module .../src/config.js`

- [ ] **Step 4: 实现 `src/config.js`**

导出 `loadConfig(env, argv)`：按上表读取环境变量，`SESSION_HUB_PORT` 用 `Number()` 且 `Number.isFinite` 校验，无效回退 `7317`；`rebuild = argv.includes('--rebuild')`；默认路径用 `os.homedir()` + `path.join`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/config.test.js`
Expected: PASS（3 个测试）

- [ ] **Step 6: 提交**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: config loader with env overrides"
```

---

### Task 2: SQLite schema 与写入

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

- [ ] **Step 1: 写 `src/schema.sql`**

使用设计文档 §6.2 的建表语句，所有 `CREATE` 都加 `IF NOT EXISTS`（包括 `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts`），保证 `initSchema` 可重复调用。并在文件末尾加索引：
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_agent_updated ON sessions(agent, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_key, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_key);
CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_key);
```

- [ ] **Step 2: 写失败的 DB 测试**

`test/db.test.js` 用 `openDb(':memory:')`：
```js
test('replaceSession 写入会话、消息、工具与 sync_state', () => {
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

test('重新 replace 会替换旧消息且不留孤儿', () => {
  // 同一 sourcePath 再写 1 条消息
  // 断言 messages/tool_calls/tool_results 数量随之变成 1/0/0
});

test('pruneMissing 删除不在 keepPaths 的会话与 sync_state', () => {
  // pruneMissing(db, new Set(['/other'])) -> sessions 0，sync_state 0
});

test('超大工具结果可入库并读回', () => {
  // output = 'x'.repeat(300 * 1024)，断言 tool_results.output.length 不变
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/db.test.js`
Expected: FAIL，`Cannot find module .../src/db.js`

- [ ] **Step 4: 实现 `src/db.js`**

- `openDb(dbPath)`：`new DatabaseSync(dbPath)`，执行 §6.1 的 PRAGMA。
- `initSchema(db)`：读取 `new URL('./schema.sql', import.meta.url)` 并 `db.exec()`。
- `replaceSession`：`db.exec('BEGIN')` → `DELETE FROM messages_fts WHERE session_key = ?` → `DELETE FROM sessions WHERE source_path = ?` 或按 key 删除 → 插入会话/消息/工具/FTS → upsert `sync_state` → `COMMIT`；出错 `ROLLBACK` 后抛出。
  - `messages.seq` 从 0 递增；`tool_calls.message_seq` / `tool_results.message_seq` 指向所属消息的 `seq`。
  - `messages_fts` 每条 user/assistant 消息插入一行，`body` 在 JS 里拼成 `text + '\n' + (thinking ?? '')`，避免 SQL `NULL` 传播。
  - `archived` 存 `0/1`。
- `pruneMissing(db, keepPaths)`：事务内删除 `source_path NOT IN keepPaths` 的 sessions 与 sync_state（用临时表或分批 `SELECT` + `DELETE`），返回删除数量。
- `clearAll(db)`：事务内依次清空 `messages_fts`、`tool_results`、`tool_calls`、`messages`、`sessions`、`sync_state`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/db.test.js`
Expected: PASS（4 个测试）

- [ ] **Step 6: 提交**

```bash
git add src/schema.sql src/db.js test/db.test.js
git commit -m "feat: sqlite schema and transactional session writes"
```

---

### Task 3: 查询、详情与检索

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

- [ ] **Step 1: 写失败的查询测试**

`test/db-query.test.js`：用 helper 写入 3 个会话：
- `claude:a`，chat `oc_A`，cwd `/p1`，updated 300，消息含「这个项目为什么构建失败」
- `codex:b`，chat `oc_B`，cwd `/p2`，updated 200，消息含「会话聚合」
- `dsh:c`，chat null，cwd `/p1`，updated 100

断言：
```js
assert.deepEqual(listSessions(db, {}).map(s => s.key), ['claude:a','codex:b','dsh:c']); // updated_at DESC
assert.deepEqual(listSessions(db, { agent:'codex' }).map(s => s.key), ['codex:b']);
assert.deepEqual(listSessions(db, { chat:'oc_A' }).map(s => s.key), ['claude:a']);
assert.deepEqual(listSessions(db, { cwd:'/p1' }).map(s => s.key), ['claude:a','dsh:c']); // updated DESC
assert.deepEqual(listSessions(db, { q:'构建失败' }).map(s => s.key), ['claude:a']);   // 4 字符 → FTS
assert.deepEqual(listSessions(db, { q:'会话' }).map(s => s.key), ['codex:b']);        // 2 字符 → LIKE
assert.equal(listSessions(db, { limit: 2 }).length, 2);
const detail = getSession(db, 'claude:a');
assert.equal(detail.messages.length, 2);
assert.equal(detail.messages[1].toolCalls[0].name, 'bash');
assert.equal(detail.messages[1].toolResults[0].output, 'ok');
assert.equal(getSession(db, 'nope'), null);
const facets = getFacets(db);
assert.deepEqual(facets.agents.map(a => a.agent).sort(), ['claude','codex','dsh']);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/db-query.test.js`
Expected: FAIL，`listSessions is not a function`

- [ ] **Step 3: 实现查询函数**

- `listSessions`：动态拼 WHERE（所有过滤值用参数绑定，不拼字符串）；`q.length >= 3` 时 `session_key IN (SELECT session_key FROM messages_fts WHERE body MATCH ?)`，查询串用双引号包裹并转义内部双引号（`'"' + q.replaceAll('"','""') + '"'`），避免 FTS 语法错误；否则 `session_key IN (SELECT session_key FROM messages WHERE text LIKE ? ESCAPE '\' OR thinking LIKE ? ESCAPE '\')`，参数为转义过 `%`/`_` 的 `%q%`。默认 `includeArchived = true`；按 `updated_at DESC` 排序；`limit` 默认 500；返回行的 `archived` 转为 boolean。
- `getSession`：查 session 行；查 messages 按 `seq`；查 tool_calls/tool_results 按 `message_seq` 组装回 Message；`archived` 转 boolean。
- `getFacets`：`GROUP BY` 三个维度，过滤 NULL chat/cwd。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/db-query.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/db.js test/db-query.test.js
git commit -m "feat: session queries, detail and fts search"
```

---

### Task 4: 文本与时间归一化

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

- [ ] **Step 1: 写失败的归一化测试**

```js
test('textFromContent 拼接 text block', () => {
  assert.equal(textFromContent('hi'), 'hi');
  assert.equal(textFromContent([{type:'text',text:'a'},{type:'tool_use'},{type:'text',text:'b'}]), 'a\nb');
  assert.equal(textFromContent([{type:'input_text',text:'q'},{type:'output_text',text:'a'}]), 'q\na');
  assert.equal(textFromContent(null), '');
});

test('stripBridgeContext 与合成文本识别', () => {
  const t = '<bridge_context>{"chatId":"oc_1"}</bridge_context>\n你好';
  assert.equal(stripBridgeContext(t), '你好');
  assert.equal(isSyntheticUserText('<environment_context>...</environment_context>'), true);
  assert.equal(isSyntheticUserText('<recommended_plugins>x</recommended_plugins>'), true);
  assert.equal(isSyntheticUserText('你好'), false);
});

test('deriveTitle 取首行并截断', () => {
  assert.equal(deriveTitle('第一行\n第二行'), '第一行');
  assert.equal(deriveTitle('<bridge_context>{}</bridge_context>\n检查构建'), '检查构建');
  assert.equal(deriveTitle('', '未命名会话'), '未命名会话');
  assert.equal(deriveTitle('x'.repeat(200)).length, 80);
});

test('toEpochMs 处理四种形态', () => {
  assert.equal(toEpochMs('2026-11-01T00:00:00.000Z'), Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(toEpochMs(1795000000), 1795000000000);       // 秒
  assert.equal(toEpochMs(1795000000000), 1795000000000);    // 毫秒
  assert.equal(toEpochMs(null), null);
  assert.equal(toEpochMs('not a date'), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/normalize.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/normalize.js`**

- `stripBridgeContext`：正则 `/<bridge_context>[\s\S]*?<\/bridge_context>/g` 删除后 `trim()`。
- `isSyntheticUserText`：trim 去 BOM 后，匹配 `^<(environment_context|recommended_plugins|user_instructions|local-command-caveat|local-command-stdout|command-name)\b`。
- `deriveTitle`：`stripBridgeContext` → 首个非空行 → `truncate(80)`；空则 fallback。
- `toEpochMs`：number 且 `< 1e12` 视为秒 ×1000；字符串用 `Date.parse`；非法或 null 返回 null。
- `textFromContent`：字符串直接返回；数组只取 `type` 为 `text` / `input_text` / `output_text` 的 `text`，用 `\n` 连接。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/normalize.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/normalize.js test/normalize.test.js
git commit -m "feat: text and time normalization helpers"
```

---

### Task 5: Claude source 解析

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

- [ ] **Step 1: 写 fixture**

`test/fixtures/claude/session-1.jsonl`（逐行合法 JSON）：
```jsonl
{"type":"queue-operation","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-11-01T00:00:00.000Z"}
{"type":"user","sessionId":"11111111-1111-4111-8111-111111111111","cwd":"/tmp/proj","timestamp":"2026-11-01T00:00:01.000Z","message":{"role":"user","content":"帮我检查构建失败"}}
{"type":"assistant","sessionId":"11111111-1111-4111-8111-111111111111","cwd":"/tmp/proj","timestamp":"2026-11-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先看日志"},{"type":"text","text":"我看一下。"},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-11-01T00:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"a.txt"}]}}
{"type":"attachment","timestamp":"2026-11-01T00:00:04.000Z"}
```

- [ ] **Step 2: 写失败的解析测试**

```js
const file = path.join(FIXTURES, 'claude/session-1.jsonl');
test('parseClaude 提取消息、思考与工具结果', async () => {
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
test('最后一行不完整时跳过、不抛错', async () => {
  // 复制 fixture 到临时目录，末尾追加 '{"type":"user","mess'
  // parseClaude -> 仍返回 2 条消息
});
test('custom-title 优先，子代理文件被忽略', async () => {
  // 临时目录：projects/p1/<uuid>.jsonl + p1/<uuid>/custom-title.json + agent-x.jsonl
  // discoverClaude -> 只返回 1 个文件；parse 的 title 用 customTitle
});
test('超大工具结果仍可解析', async () => {
  // 构造 300KB 的 tool_result 行 -> 不抛错
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/sources-claude.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 4: 实现 `src/sources/claude.js`**

- `discoverClaude(config)`：
  - 遍历 `${roots.claude}/projects/*/` 顶层 `*.jsonl`；basename 必须匹配 `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/`；跳过 `agent-*`。
  - `stat` 取 mtimeMs/size；`nativeId` = 去 `.jsonl`；若存在 `<sessionId>/custom-title.json` 则读 `customTitle` 作为 `titleHint`。
  - 目录不存在返回 `[]`，不抛错。
- `parseClaude`：逐行 `JSON.parse`，失败的行（含末尾半行）跳过。只处理 `type` 为 `user`/`assistant`：
  - block `text` → 文本；`thinking` → `thinking`；`tool_use` → `toolCalls`；`tool_result` → 根据 `tool_use_id` 挂到此前含该调用的消息的 `toolResults`（维护 `callId -> messageIndex`）。
  - 无文本、无思考、无工具的消息跳过。
  - 标题：`discovery?.titleHint || deriveTitle(首个真实用户文本) || '未命名会话'`；真实用户文本跳过 `isSyntheticUserText`。
  - `cwd`、`createdAt` 取首个带值的条目。
  - `nativeId` 取条目 `sessionId`，否则文件名。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/sources-claude.test.js`
Expected: PASS（4 个测试）

- [ ] **Step 6: 提交**

```bash
git add src/sources/claude.js test/sources-claude.test.js test/fixtures/claude
git commit -m "feat: claude transcript discovery and parser"
```

---

### Task 6: Codex source 解析

**Files:**
- Create: `src/sources/codex.js`, `test/sources-codex.test.js`, `test/fixtures/codex/rollout-1.jsonl`, `test/fixtures/codex/subagent.jsonl`, `test/fixtures/codex/session_index.jsonl`

**Interfaces:**
- Produces: `discoverCodex(config): Promise<DiscoveredFile[]>`、`parseCodex(sourcePath, discovery?): Promise<ParsedSession>`

- [ ] **Step 1: 写 fixtures**

`rollout-1.jsonl`：
```jsonl
{"type":"session_meta","payload":{"id":"22222222-2222-4222-8222-222222222222","cwd":"/tmp/codex","timestamp":"2026-11-01T00:00:00.000Z"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"检查构建失败"}]}}
{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"先看日志"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"我看一下。"}]}}
{"type":"response_item","payload":{"type":"function_call","id":"fc_toolu_1","call_id":"toolu_1","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"toolu_1","output":"a.txt"}}
```
`subagent.jsonl`：首行 `session_meta.payload` 带 `"parent_thread_id":"parent"`。
`session_index.jsonl`：`{"id":"22222222-2222-4222-8222-222222222222","thread_name":"检查构建","updated_at":"2026-11-01T00:00:05.000Z"}`

- [ ] **Step 2: 写失败的测试**

```js
test('parseCodex 提取消息、思考、工具', async () => {
  const p = await parseCodex(rollout, { titleHint: '检查构建' });
  assert.equal(p.nativeId, '22222222-2222-4222-8222-222222222222');
  assert.equal(p.cwd, '/tmp/codex');
  assert.equal(p.title, '检查构建');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[1].thinking, '先看日志');
  assert.deepEqual(p.messages[1].toolCalls[0], { id:'toolu_1', name:'shell', input:{cmd:'ls'} });
  assert.deepEqual(p.messages[1].toolResults[0], { callId:'toolu_1', output:'a.txt', isError:false });
});
test('discoverCodex 读取索引标题并排除子代理', async () => {
  // 临时 codex 根：sessions/2026/11/01/rollout-1.jsonl + subagent.jsonl + session_index.jsonl
  const files = await discoverCodex({ roots: { codex: tmpRoot } });
  assert.equal(files.length, 1);
  assert.equal(files[0].titleHint, '检查构建');
});
test('缺失索引时回退首条真实用户文本', async () => {
  // 去掉 session_index.jsonl -> title === '检查构建失败'
});
test('末尾半行与未知事件被跳过', async () => {
  // 追加半行 + {"type":"world_state"} -> 仍 2 条消息
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/sources-codex.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 4: 实现 `src/sources/codex.js`**

- `discoverCodex`：遍历 `${roots.codex}/sessions/**/rollout-*.jsonl` 与 `${roots.codex}/archived_sessions/*.jsonl`（archived=true）。对每个文件只读首行判断 `payload.parent_thread_id || payload.forked_from_id || payload.agent_path`，有则跳过。读 `${roots.codex}/session_index.jsonl` 建 `id → thread_name`，作为 `titleHint`。`nativeId` 取 `payload.id || payload.session_id || 文件名中的 UUID`。
- `parseCodex`：逐行解析；`session_meta` 取 cwd/timestamp/nativeId；`response_item`：
  - `payload.type === 'message'` 且 role 为 `user`/`assistant` → 文本 `textFromContent(content)`；跳过 `developer`；用户文本 `isSyntheticUserText` 为真则整条跳过。
  - `reasoning` → 暂存 `summary[].text`，挂到下一条 assistant 的 `thinking`。
  - `function_call` / `custom_tool_call` → `{ id: payload.call_id || payload.id, name, input }`（`arguments` 尝试 `JSON.parse`，失败保留原始字符串）；`*_output` 按 `call_id` 挂到所属消息；精确匹配失败时再尝试去掉 `fc_` / `ctc_` 前缀后匹配。
  - `event_msg`、`world_state`、`turn_context`、`token_usage_record` 忽略（token 可选取 `usage.total_tokens`）。
  - 标题：`titleHint || deriveTitle(首条真实用户文本) || '未命名会话 · ' + nativeId.slice(0,8)`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/sources-codex.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/sources/codex.js test/sources-codex.test.js test/fixtures/codex
git commit -m "feat: codex rollout discovery and parser"
```

---

### Task 7: dsh source 解析

**Files:**
- Create: `src/sources/dsh.js`, `test/sources-dsh.test.js`

**Interfaces:**
- Produces: `discoverDsh(config): Promise<DiscoveredFile[]>`、`parseDsh(sourcePath, discovery?): Promise<ParsedSession>`

- [ ] **Step 1: 写测试 helper 与失败的测试**

helper：把 JSONL 行数组用 `zlib.zstdCompressSync(Buffer.from(lines.join('\n')))` 写入临时 `<slug>/<sessionDir>/session.v4.jsonl.zstd`。

```js
test('parseDsh 提取元数据、标题、消息与工具', async () => {
  // 行：session / user/message / session/title / assistant/message(text+reasoning)
  //     / tool/call / tool/result / turn/end
  const p = await parseDsh(file);
  assert.equal(p.nativeId, 'session-33333333-3333-4333-8333-333333333333');
  assert.equal(p.cwd, '/tmp/dsh');
  assert.equal(p.title, '扩展这个库');
  assert.equal(p.messages.length, 2);
  assert.equal(p.messages[1].thinking, '先读文档');
  assert.deepEqual(p.messages[1].toolCalls[0], { id:'tool-1', name:'read', input:{path:'README.md'} });
  assert.deepEqual(p.messages[1].toolResults[0], { callId:'tool-1', output:'# README', isError:false });
});
test('discoverDsh 找出 zstd 会话并按目录名提取 chatId', async () => {
  // 两个会话：session-xxx 与 lark-oc_ABC--hash
  // files.length === 2；后者 chatHint === 'oc_ABC'
});
test('缺少 projcache 与损坏压缩文件不影响其它会话', async () => {
  // 一个坏 .zstd（非 zstd 字节）-> parse 抛错由调用方处理；discover 仍列出
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/sources-dsh.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/sources/dsh.js`**

- `discoverDsh`：遍历 `${roots.dsh}/sessions/*/*/session.v4.jsonl.zstd`；`chatHint = /^lark-(oc_[A-Za-z0-9]+)/` 匹配目录名；`stat` 取 mtime/size。
- `parseDsh`：`zlib.zstdDecompressSync(await readFile(path))` → `split('\n')` 逐行解析：
  - `session` → nativeId/id、cwd、createdAt
  - `user/message` → 文本（`data.content[].text`）
  - `assistant/message` → `data.message.content[]`，`text` / `reasoning`
  - `session/title` → 覆盖标题（取最后一条）
  - `tool/call` → `{callId, name, arguments}`；`tool/result` → 按 `toolCallId` 挂到所属消息（用 callId→messageIndex）
  - `system/message` / `developer/message` 不展示
  - 其它事件忽略
  - 可选：若 `${roots.dsh}/storages/session_projcache/sessions/<id>.json` 存在，读 `record.rows.tokenMeasurement.val.anchor.usage.totalTokens` 作为 `tokens`
- 标题回退：`session/title` → 首条用户文本 → `'未命名会话'`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/sources-dsh.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sources/dsh.js test/sources-dsh.test.js
git commit -m "feat: dsh zstd session discovery and parser"
```

---

### Task 8: 飞书会话映射

**Files:**
- Create: `src/sources/larkMap.js`, `test/lark-map.test.js`

**Interfaces:**
- Produces:
  ```ts
  buildChatMap(config): Promise<Map<string, string>>   // key: `${agent}:${nativeId}` -> chatId
  chatIdFromDshDir(dirName: string): string | null
  ```

- [ ] **Step 1: 写失败的测试**

```js
test('读取 claude/codex catalog 并建立映射', async () => {
  // 临时 larkChannel 根：profiles/claude/sessions.json.catalog.json
  //   [{scopeId:'oc_A',agentId:'claude',sessionId:'s1'}]
  // profiles/codex/sessions.json.catalog.json
  //   [{scopeId:'oc_B',agentId:'codex',threadId:'t1'}]
  const m = await buildChatMap({ roots: { larkChannel: tmp } });
  assert.equal(m.get('claude:s1'), 'oc_A');
  assert.equal(m.get('codex:t1'), 'oc_B');
});
test('catalog 缺失或损坏返回空映射而不抛错', async () => {
  // 不存在 -> new Map(); 写 'not json' -> new Map()
});
test('dsh 目录名提取 chatId', () => {
  assert.equal(chatIdFromDshDir('lark-oc_ABC123'), 'oc_ABC123');
  assert.equal(chatIdFromDshDir('lark-oc_ABC123--800327b4cf'), 'oc_ABC123');
  assert.equal(chatIdFromDshDir('session-abc'), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/lark-map.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/sources/larkMap.js`**

读取两个 catalog（`try/catch` 吞掉缺失与解析错误），元素取 `scopeId` 与 `sessionId || threadId`，写入 `Map`。`chatIdFromDshDir` 用 `/^lark-(oc_[A-Za-z0-9]+)/`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/lark-map.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sources/larkMap.js test/lark-map.test.js
git commit -m "feat: map native sessions to feishu chat ids"
```

---

### Task 9: 同步编排

**Files:**
- Create: `src/sync.js`, `test/sync.test.js`

**Interfaces:**
- Produces:
  ```ts
  syncOnce(db, config, opts?: { chatMap?: Map<string,string>; force?: boolean }):
    Promise<{ added, updated, unchanged, removed, warnings: string[] }>
  ```

- [ ] **Step 1: 写失败的同步测试**

用临时目录构造最小的三源数据（复用 Task 5–7 的 fixture 生成逻辑），`openDb(':memory:')` + `initSchema`。

```js
test('首次同步写入三源会话', async () => {
  const r = await syncOnce(db, config);
  assert.equal(r.added, 3);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 3);
});
test('二次同步未变化时全部 unchanged', async () => {
  const r = await syncOnce(db, config);
  assert.deepEqual({ added:r.added, updated:r.updated, unchanged:r.unchanged, removed:r.removed },
                   { added:0, updated:0, unchanged:3, removed:0 });
});
test('追加内容只更新对应会话', async () => {
  // 向 claude fixture 追加一条 user 行 -> updated 1, 该会话 message_count +1
});
test('删除源文件后清理会话', async () => {
  // unlink 一个文件 -> removed 1
});
test('源根目录不存在时仍完成并产生 warning', async () => {
  // roots 全部指向不存在路径 -> 不抛错；warnings 至少一条包含其中某个路径；sessions 0
});
test('源根目录缺失时不会误删已有会话', async () => {
  // 先正常同步一次；再把某个 root 指向不存在路径再同步 -> 该来源旧会话仍在，removed 0
});
test('坏文件不阻塞其它会话且保留旧数据', async () => {
  // 把某文件改成非法内容并改 mtime -> warning，其它会话仍同步
});
test('catalog 缺失时 chatId 为 null', async () => {
  // 不提供 larkChannel 根 -> listSessions 的 chatId 全 null
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/sync.js`**

1. `chatMap = opts.chatMap ?? await buildChatMap(config)`。
2. 对每个 root 先 `stat`：不存在或不可读时 push 一条 warning（含路径），该来源按空列表处理。然后 `Promise.all([discoverClaude, discoverCodex, discoverDsh])`，各自再包 `try/catch`，失败时 push warning 并当作空列表。
3. 对每个 `DiscoveredFile`：
   - `getSyncState(db, sourcePath)`；未变化且 `!force` → `unchanged++`，跳过。
   - `parseXxx`（按 agent 分派）；失败 → warning，保留旧数据。
   - 组装 `SessionRow`：`key = agent + ':' + nativeId`；`chatId = chatMap.get(key) ?? file.chatHint ?? null`；`updatedAt = Math.floor(file.mtimeMs)`；`messageCount = messages.length`；`extraJson = JSON.stringify(parsed.extra ?? null)`。
   - `hasSession` 判断 added/updated；`replaceSession(..., { mtimeMs, size })`。
4. 仅当三个来源的发现都成功时执行 `pruneMissing(db, new Set(所有发现路径))` → `removed`；任何一个来源根缺失或发现失败就跳过清理，避免误删旧会话。
5. 返回统计与 warnings。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/sync.js test/sync.test.js
git commit -m "feat: incremental sync orchestrator"
```

---

### Task 10: HTTP API 与静态服务

**Files:**
- Create: `src/server.js`, `test/server.test.js`

**Interfaces:**
- Produces:
  ```ts
  createServer({ db, state, publicDir }): http.Server
  // state: { scanning: boolean; lastSyncAt: number|null; warnings: string[] }
  ```

- [ ] **Step 1: 写失败的 API 测试**

用临时 DB 写入 2 个会话，`createServer(...).listen(0)`，用 `fetch` 请求：

```js
test('GET /api/sessions 返回列表与 facets', async () => {
  const res = await fetch(base + '/api/sessions');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessions.length, 2);
  assert.ok(Array.isArray(body.facets.agents));
});
test('过滤与搜索参数生效', async () => {
  const body = await (await fetch(base + '/api/sessions?agent=claude')).json();
  assert.equal(body.sessions.length, 1);
  const s = await (await fetch(base + '/api/sessions?q=构建失败')).json();
  assert.equal(s.sessions.length, 1);
});
test('GET /api/session 返回详情，未知 key 404', async () => {
  const ok = await fetch(base + '/api/session?key=' + encodeURIComponent('claude:a'));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).messages.length, 2);
  assert.equal((await fetch(base + '/api/session?key=nope')).status, 404);
});
test('GET /api/health 报告状态', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.sessions, 2);
  assert.equal(h.scanning, false);
});
test('静态文件与路径穿越防护', async () => {
  // 测试用临时 publicDir，放入一个含 id="app" 的 index.html
  // GET / -> 200 text/html，body 含 id="app"
  // GET /../package.json -> 404
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/server.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `src/server.js`**

- 路由：`/api/health`、`/api/sessions`、`/api/session`、`/api/facets`；其余按路径读 `publicDir`。
- `key` 从 query 取，`decodeURIComponent` 后传给 `getSession`。
- 静态：`path.normalize` + `startsWith(publicDir + path.sep)` 防穿越；`index.html` 用于 `/`；设置 `Content-Type`（`text/html; charset=utf-8`、`text/javascript`、`text/css`）。
- 所有响应加 `Cache-Control: no-store`。
- 未知 API 路径 404 JSON；非 GET 405。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/server.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: json api and static file server"
```

---

### Task 11: 前端看板

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/style.css`

**Interfaces:**
- Consumes: `/api/sessions`、`/api/session?key=`、`/api/facets`
- Produces: 静态页面，`#app` 容器

- [ ] **Step 1: 写 `public/index.html`**

骨架：顶部筛选区（`#agent-chips`、`#search`）、左列表 `#session-list`、右详情 `#session-detail`、`#status`。加载 `app.js`、`style.css`。包含 `<div id="app">`。

- [ ] **Step 2: 写 `public/style.css`**

两栏布局（`display:grid; grid-template-columns: 360px 1fr`）；agent 色点（claude 紫、codex 绿、dsh 蓝）；消息气泡、工具 `<details>` 等宽字体；窄屏单栏。

- [ ] **Step 3: 写 `public/app.js`**

- 状态：`{ agent: 'all', q: '', selected: null }`，从 `location.hash` / `localStorage` 恢复。
- `loadSessions()`：`fetch('/api/sessions?...')` → 渲染 chips 数量与列表；每 5s 轮询。
- `openSession(key)`：`fetch('/api/session?key=...')` → 渲染详情；每 3s 轮询，`updatedAt`/`messageCount` 变化才重绘。
- 列表项：标题、agent、chatId（或“本地会话”）、相对时间、cwd、消息数。
- 详情：元数据头 + 消息流；`thinking` 与每个工具调用/结果用 `<details>`；文本用 `textContent` 渲染（防 XSS）。
- 搜索：300ms 防抖，写回 `location.hash`。
- 空状态、加载中、错误提示。

- [ ] **Step 4: 手动验证静态页面**

在仓库根目录运行：
```bash
node --input-type=module -e "
import { openDb, initSchema } from './src/db.js';
import { createServer } from './src/server.js';
const db = openDb(':memory:'); initSchema(db);
createServer({ db, state: { scanning:false, lastSyncAt:null, warnings:[] }, publicDir: process.cwd() + '/public' })
  .listen(7317, '127.0.0.1', () => console.log('http://127.0.0.1:7317'));
"
```

打开浏览器，确认页面能加载、无控制台报错；列表为空时显示空状态。

- [ ] **Step 5: 提交**

```bash
git add public
git commit -m "feat: read-only session hub web ui"
```

---

### Task 12: 入口、后台同步与 README

**Files:**
- Create: `src/index.js`, `README.md`
- Modify: none

**Interfaces:**
- Consumes: `loadConfig`、`openDb` / `initSchema` / `clearAll`、`syncOnce`、`createServer`

- [ ] **Step 1: 实现 `src/index.js`**

流程：
1. `const config = loadConfig()`。
2. `mkdir(dirname(config.dbPath), { recursive: true })`。
3. `openDb` → `initSchema`；`config.rebuild` 时 `clearAll(db)` 并 `force` 首次同步。
4. `state = { scanning: true, lastSyncAt: null, warnings: [] }`。
5. 启动 `http.Server` 监听 `config.host:config.port`，打印 `Session Hub → http://host:port`。
6. `runSync()`：若 `state.scanning` 为真直接返回（防重入）；否则 `state.scanning = true` → `try { syncOnce } finally { state.scanning = false }`，更新 `lastSyncAt`、`warnings`；`setInterval(runSync, 5000)`。
7. `SIGINT`/`SIGTERM`：清定时器、`server.close()`、`db.close()`、退出。

- [ ] **Step 2: 写 `README.md`**

包含：用途、只读声明、前置条件（Node ≥ 22.5，本机三处数据来源）、`npm start`、`--rebuild`、环境变量表、数据位置 `~/.session-hub/hub.db`、隐私提示（transcript 可能含密钥，不要暴露到公网）、测试命令。

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 所有测试 PASS。

- [ ] **Step 4: 手动端到端验收**

```bash
npm start
```
按设计文档 §12 手动验收：
1. 打印 URL，页面可打开。
2. 数量符合规则：Claude 顶层 UUID（当前 52）、Codex 排除 fork（当前 18）、dsh（当前 16）。
3. agent / chat / cwd / 搜索过滤生效。
4. 详情消息顺序、工具折叠正确。
5. 向某会话文件追加一行后 5s 内更新。
6. `~/.session-hub/hub.db` 生成；删除后重启可重建；源目录内容与 mtime 未被修改。
7. `npm test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/index.js README.md
git commit -m "feat: entry point, background sync and docs"
```

---

## 自检记录

- **Spec 覆盖**：配置（Task 1）、SQLite 副本与 schema（2–3）、三源解析（5–7）、chat 映射（8）、增量同步（9）、API（10）、UI（11）、入口/重建/README（12）、只读与安全（全局约束 + 12）。
- **类型一致**：`DiscoveredFile` / `ParsedSession` / `SessionRow` / `Message` 在 Task 2 定义后，后续任务引用同一字段名；`listSessions` / `getSession` / `getFacets` 与 server 一致。
- **Review Focus 落点**：半行 JSON（5/6/7）、超大工具结果（2/5）、源根缺失（9）、catalog 损坏（8/9）、时间形态（4）。
