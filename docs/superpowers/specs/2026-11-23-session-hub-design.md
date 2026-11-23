# Session Hub — 只读会话聚合看板 设计

- 日期：2026-11-23
- 状态：待批准（MVP）
- 工作目录：`/Users/felinx/Documents/Claude/ai-agent-session-hub`

## 1. 意图与为什么

用户日常通过两套 bridge 在飞书里使用三种 agent：

- `lark-coding-agent-bridge`（本机 v0.7.1）的 Claude 和 Codex profile
- `dsh-lark-channel` 的 dsh（DeepSeek Harness）

他想把所有 agent 的会话聚合到一个地方，先获得跨 agent 的统一视角：翻看、检索、回顾。只读 MVP 用来验证这个视角是否有价值；续聊 / 派活是之后的阶段，不在本次范围。

## 2. 目标 / 非目标 / 反目标

### 目标

1. 本机一条命令启动，浏览器打开一个看板。
2. 自动发现三个来源的全部会话，统一列表展示。
3. 可按 agent、飞书会话、工作目录、时间过滤；支持全文搜索。
4. 点开可读完整对话，工具调用与结果默认折叠。
5. 会话文件变化时，页面在数秒内自动刷新。
6. 全程不修改任何源数据。
7. 把读到的会话结构化复制到自己的 SQLite 数据库；列表、详情、搜索都基于这份副本，可随时重建。

### 非目标

- 续聊、resume、分叉、写回任何 agent。
- 通过飞书 API 获取聊天名称、成员、消息。
- 鉴权、多用户、远程访问、跨机器同步。
- 流式渲染运行中 agent 的实时 token 输出（只按文件落盘内容刷新）。
- 图片附件预览（先显示附件路径/占位）。

### 反目标

- 需要改动或重启两套 bridge 才能工作。
- 依赖任何云端服务或外网请求。
- 启动后持续高 CPU / 反复全量扫描 188MB。

## 3. 约束

- macOS，本机 Node v26.13.1（需 ≥ 22.15 才有 `node:zlib` 的 zstd API）。
- **零运行时依赖**：只用 `node:http`、`node:fs/promises`、`node:zlib`、`node:path`、`node:os`、`node:sqlite`。
  - `node:sqlite` 从 Node 22.5 起内置；本机 SQLite 3.54.1 已实测支持 FTS5 trigram。
- 数据量（2026-11-23 实测）：
  - Claude：102 个 `.jsonl`，约 188MB；其中**顶层 UUID 会话 52 个**，其余 51 个是子代理 transcript（不计入会话列表）
  - Codex：活动 + archived 共 21 个 rollout；其中 3 个是 fork/子代理线程（不计入会话列表）
  - dsh：16 个会话，压缩后约 3.3MB

> 数字是快照，会随使用增长；验收以“用户可见会话”的规则为准，不写死数量。
- 上游格式会变化：解析器必须容错，未知事件 / 未知 block 一律跳过并记录 warning，不能整体失败。
- 源目录只读；应用自身的写入只发生在 `~/.session-hub/`；服务只绑定 `127.0.0.1`。

## 4. 方案选择

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. 独立本地 Web 看板** | 新增零依赖 Node 服务，扫描三源，统一 API + 浏览器 UI；不碰 bridge | **选定** |
| B. 扩展 lark-coding-agent-bridge 控制台 | 在其 `web/` 加 Sessions 页，复用 React 控制台 | 放弃：绑定第三方仓库；直接覆盖不到 dsh；上游升级合并成本高 |
| C. 终端 CLI/TUI | `shub list/show/search` | 放弃：长对话在终端难读，不像“应用” |

选 A 的理由：只读、零侵入、三个来源平权；bridge 升级和 dsh 升级都不影响它；以后要加“续聊/派活”，这个服务是自然的落点。

## 5. 数据源与归一化

所有路径默认从 `os.homedir()` 推导，可用环境变量覆盖（见 §9）。

### 5.1 Claude（lark-coding-agent-bridge 的 claude profile）

- **文件**：`~/.claude/projects/<project-slug>/<sessionId>.jsonl`
  - 只取项目目录**顶层**、文件名为 UUID 的 `*.jsonl`。
  - 忽略 `agent-*.jsonl`（子代理 transcript）和 `<sessionId>/` 子目录（`custom-title.json`、`tool-results/`、`subagents/`）。子代理属于内部线程，MVP 不进入列表。
- **标题**：
  1. `~/.claude/projects/<project-slug>/<sessionId>/custom-title.json` 的 `customTitle`
  2. 否则取第一条“真实用户文本”，清洗后截断 80 字符
     - 跳过 `<local-command-caveat>...`、`<local-command-...>`、`<command-...>` 开头的内部条目
     - 去掉 `<bridge_context>...</bridge_context>` 块
     - 取第一行非空文本
  3. 再否则 `未命名会话`
- **元数据**：`cwd`、`sessionId` 取自条目字段；首条带 `timestamp` 的条目作为 `createdAt`；文件 mtime 作为 `updatedAt` 的兜底。
- **消息**：只处理 `type === "user" | "assistant"` 的条目：
  - `message.content` 可能是字符串或 block 数组。block 类型：
    - `text` → 文本
    - `thinking` / `redacted_thinking` → 折叠的 thinking
    - `tool_use` → `{id, name, input}`
    - `tool_result` → 以 `tool_use_id` 关联到对应调用
  - 同一条目可能混合文本与工具块。
  - `timestamp` 为 ISO 字符串。
- **忽略**：`attachment`、`api-request`、`api-request-shape`、`api-request-blob`、`queue-operation`、`atis-latch`、`last-prompt`、`tools-used`、`summary`（不存在于本机）等内部事件。
- **容错**：单行 JSON 解析失败跳过；单文件致命错误记录 warning 并跳过该会话。

### 5.2 Codex（lark-coding-agent-bridge 的 codex profile）

- **文件**：
  - `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  - `~/.codex/archived_sessions/rollout-*.jsonl`（标记 `archived: true`）
- **排除子代理**：`session_meta.payload` 含 `parent_thread_id`、`forked_from_id` 或 `agent_path` 的 rollout 是 fork/子代理线程，MVP 不进入列表（本机有 3 个）。将来可作为“相关会话”挂在父会话下。
- **标题**：`~/.codex/session_index.jsonl` 中 `{id, thread_name, updated_at}` 的 `thread_name`。缺失时取首条“真实用户文本”：跳过 `<environment_context>`、`<recommended_plugins>`、`<user_instructions>`、`<bridge_context>` 等注入块；没有可用用户文本则退到首条 assistant 文本，再退到 `未命名会话 · <id 前 8 位>`。
- **元数据**：首行 `type === "session_meta"` 的 `payload`：`id` / `session_id`、`cwd`、`timestamp`。
- **消息**：只取 `type === "response_item"` 且 `payload.type === "message"`：
  - `payload.role === "user" | "assistant"`；跳过 `developer`（注入的 instructions）。
  - `payload.content[]` 中 `type` 为 `input_text` / `output_text` / `text` 的取 `text`。
  - 整条 user 文本只由上述合成标签块构成时，跳过不展示。
- **工具**：
  - `payload.type === "function_call"` → `{id, name, arguments(JSON 字符串)}`
  - `payload.type === "custom_tool_call"` → `{id, name, input}`
  - `function_call_output` / `custom_tool_call_output` → 按 `call_id` 关联
  - `reasoning` → thinking，折叠
- **忽略**：`event_msg`（其中 `item_completed` / `task_complete` 与 response_item 重复）、`world_state`、`turn_context`、`token_usage_record`（token 用量可选地取 `payload.usage.total_tokens`）。
- **注意**：同一 session 的 rollout 文件是追加写入的，按行顺序即为时间顺序。

### 5.3 dsh（dsh-lark-channel）

- **文件**：`~/.dsh/sessions/<project-slug>/<sessionDir>/session.v4.jsonl.zstd`
  - 用 `zlib.zstdDecompressSync` 解压后按行解析。
  - `<sessionDir>` 形如 `session-<uuid>`、`lark-oc_<chatId>`、`lark-oc_<chatId>--<hash>`。
- **元数据**：首行 `type === "session"` 的 `{id, createdAt, cwd}`；每行事件带 `time`（毫秒）。
- **标题**：最后一条 `type === "session/title"` 的 `data.title`；否则首条 `user/message` 文本。
- **消息**：
  - `user/message` → `data.content[].text`（role=user）
  - `assistant/message` → `data.message.content[]`，block `type` 为 `text` / `reasoning`
  - `system/message`、`developer/message` → 默认不展示（可折叠的 system）
- **工具**：
  - `tool/call` → `{callId, name, arguments(JSON 字符串)}`
  - `tool/result` → `toolCallId` + `message.content[].text`，按 `toolCallId` 关联
- **忽略**：`step/start`、`step/end`、`turn/start`、`turn/end`、`request/*`、`job/*`、`agent/inbox/spliced`、`approval/*`、`todo/write`、`workspace/changes` 等内部事件（将来可用于状态展示）。
- **可选统计**：读 `~/.dsh/storages/session_projcache/sessions/<id>.json`（version 7），取 `record.identity.createdAt/cwd`、`record.rows.sessionStats.val`、`record.rows.tokenMeasurement.val.anchor.usage.totalTokens`；缺失不影响主流程。

### 5.4 飞书会话映射（chatId）

- **Claude / Codex**：读 `~/.lark-channel/profiles/<agent>/sessions.json.catalog.json`（JSON 数组）。元素形如：
  ```json
  {"scopeId":"oc_...","agentId":"claude","cwdRealpath":"/path","status":"active","sessionId":"..."}
  ```
  Codex 元素用 `threadId` 代替 `sessionId`。建立 `nativeId → {scopeId, cwd}` 映射。
  另可读同目录 `sessions.json`（`chatId → {sessionId, cwd, updatedAt}`）作为补充。
- **dsh**：从 session 目录名提取：`/^lark-(oc_[A-Za-z0-9]+)/` → chatId。
- 未匹配到 chatId 的会话（终端里直接启动的）显示为“本地会话”。

### 5.5 统一模型

```ts
type Agent = 'claude' | 'codex' | 'dsh';

interface SessionMeta {
  key: string;              // `${agent}:${nativeId}`
  agent: Agent;
  nativeId: string;
  title: string;
  cwd: string | null;
  chatId: string | null;    // 飞书会话/话题 scope id
  createdAt: number | null; // epoch ms
  updatedAt: number;        // epoch ms（文件 mtime 兜底）
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

`key` 中的 `nativeId` 做 `encodeURIComponent`，API 里再解码。

## 6. SQLite 副本与同步

服务维护自己的一份结构化副本；**源目录始终只读**，所有写入只发生在应用自己的数据目录。

### 6.1 数据库位置与设置

- 默认 `~/.session-hub/hub.db`（目录和文件由本应用创建），可用 `SESSION_HUB_DB` 覆盖。
- 使用 Node 内置 `node:sqlite` 的 `DatabaseSync`，不引入外部依赖。
- 连接后执行：
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  ```
- 源文件是唯一事实来源；DB 可随时删除重建。

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
  seq         INTEGER NOT NULL,           -- 会话内顺序
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

-- 全文检索：trigram 适合中文子串；本机 SQLite 3.54.1 已验证
CREATE VIRTUAL TABLE messages_fts USING fts5(
  session_key UNINDEXED,
  seq UNINDEXED,
  body,
  tokenize = 'trigram'
);
```

- 索引：`sessions(agent, updated_at DESC)`、`sessions(chat_id)`、`messages(session_key, seq)`、工具表 `(session_key)`。
- `messages_fts.body` = 该条消息的 `text + thinking`（仅 user / assistant），写入事务里维护；重同步时按 `session_key` 先删后插。
- **短查询**：trigram 要求查询至少 3 个字符，中文两字词（如“会话”）会命中 0 条。`q` 长度 < 3 时退化为 `LIKE '%q%'`；≥ 3 用 FTS。

### 6.3 同步流程

1. **扫描**：遍历三个来源的文件列表（§5）。
2. **比较**：对每个文件 `stat`，与 `sync_state` 的 `mtime_ms` / `size` 比较；未变化直接跳过。
3. **解析**：仅对变化的文件读完整 transcript（元数据、消息、工具结果）。
4. **写入**：单事务内
   - `DELETE FROM sessions WHERE source_path = ?`（外键级联删除消息、工具）
   - `DELETE FROM messages_fts WHERE session_key = ?`
   - 插入新的 `sessions` / `messages` / `tool_calls` / `tool_results` / `messages_fts`
   - upsert `sync_state`
5. **清理**：源文件已消失的会话与 `sync_state` 行一并删除。
6. **状态**：内存维护 `{ scanning, lastSyncAt, warnings[] }`，供 `/api/health`。

- **首次同步**：Claude 约 188MB，后台执行；若 DB 已有数据，API 立即可用，同步完成后再刷新。
- **增量**：后台每 5s 只 `stat`，有变化才解析。
- **重建**：`npm start -- --rebuild` 清空所有表后全量重扫。
- **单文件失败**：记录 warning，保留旧数据，不阻塞其他文件。

### 6.4 读取

- `/api/sessions` 和 `/api/session` 全部读 DB，不再按需解析源文件。
- 前端：列表每 5s 轮询；详情页每 3s 轮询，用 `messageCount` / `updatedAt` 判断是否重绘。

## 7. 服务端 API

全部返回 JSON（UTF-8）；错误返回 `{error}` 与 4xx/5xx。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions?agent=&chat=&cwd=&q=&since=&limit=` | 会话列表 + facets；`q` 为不区分大小写的子串搜索 |
| GET | `/api/session?key=<agent:nativeId>` | 元数据 + 按时间排序的 messages |
| GET | `/api/facets` | 各 agent 数量、chatId 列表、cwd 列表 |
| GET | `/api/health` | `{ok, scanning, sessions, warnings}` |
| GET | `/` 及静态资源 | 从 `public/` 提供 |

- 搜索范围：user / assistant 的文本与 thinking（不含工具输出，避免噪音和索引膨胀）。`q` ≥ 3 字符走 FTS5 trigram，1–2 字符走 `LIKE`（见 §6.2）。
- 解析失败的单个文件进入 `warnings`，不影响其他会话。
- 会话列表默认按 `updatedAt` 倒序。

## 8. UI

单页，中文界面，无构建步骤（原生 HTML/CSS/JS）。

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

- 顶栏：agent 过滤 chips（带数量）+ 搜索框；chips 与搜索在 URL hash / query 中保持。
- 左列：标题、agent 色点、chatId（全量显示或悬停）、相对时间、cwd 缩写、消息数。
- 右栏：
  - 头部元数据：agent、时间范围、cwd、chatId（可复制）、消息数、tokens（若有）。
  - user / assistant 用不同底色；assistant 的 thinking 与每个工具调用/结果用 `<details>` 折叠；工具参数与结果等宽字体，超长截断并可展开。
  - 滚动到底部按钮。
- URL：`#/s/<key>` 可直接打开某会话；刷新后恢复。
- 空状态：“没有匹配的会话”；扫描中显示进度提示。

## 9. 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_HUB_HOST` | `127.0.0.1` | 绑定地址 |
| `SESSION_HUB_PORT` | `7317` | 端口 |
| `SESSION_HUB_DB` | `~/.session-hub/hub.db` | 自有 SQLite 副本路径 |
| `CLAUDE_HOME` | `~/.claude` | Claude 数据根（只读） |
| `CODEX_HOME` | `~/.codex` | Codex 数据根（只读） |
| `DSH_HOME` | `~/.dsh` | dsh 数据根（只读） |
| `LARK_CHANNEL_HOME` | `~/.lark-channel` | bridge 状态根（只读 catalog） |

启动参数 `--rebuild`：清空 DB 后全量重扫。

启动输出：`Session Hub → http://127.0.0.1:7317`。

## 10. 文件布局

```
ai-agent-session-hub/
├── package.json          # type: module；scripts: start / test
├── README.md
├── src/
│   ├── index.js          # 入口：配置 + 打开 DB + 首次同步 + server
│   ├── config.js
│   ├── server.js         # node:http 路由 + 静态文件
│   ├── db.js             # node:sqlite 连接、schema、读写封装
│   ├── schema.sql        # 建表 / 索引 / FTS
│   ├── sync.js           # 扫描、mtime 比较、解析、事务写入、清理
│   ├── normalize.js      # 统一模型 & 文本清洗/标题
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
│   └── fixtures/         # 从真实数据裁剪、脱敏的小样本
└── docs/superpowers/specs/2026-11-23-session-hub-design.md
```

每个 source 模块导出：

```js
export async function discover(config, state) // 返回文件列表 + 元数据
export async function parseSession(file, meta) // 返回 Message[]
```

## 11. 安全与隐私

- 只绑定 `127.0.0.1`，不做鉴权；文档与页面明确提示“本机使用”。
- 不发起任何外网请求。
- **不写入任何源目录**：源文件只以只读方式打开；所有结构化副本和索引只写入 `~/.session-hub/hub.db`。
- transcript 可能包含密钥/隐私内容：README 说明不要暴露到公网，也不要截图分享。

## 12. 测试与验收

### 自动化

- 用 `node:test` + `node:assert`，零依赖。
- 每个 parser 一份 fixture（从真实会话裁剪 10–30 行并脱敏），断言：
  - 标题、cwd、chatId、消息顺序
  - 文本 / thinking / 工具调用与结果的关联
  - 未知事件被跳过且不抛错
- `lark-map`：三种 catalog 形态 + dsh 目录名正则。
- `sync` / `db`：临时 DB + 临时源目录，验证：
  - 首次同步写入正确；
  - 文件未变时不重复写（幂等）；
  - 文件追加后只更新该会话；
  - 源文件删除后相应行被清理；
  - ≥3 字符查询走 FTS、1–2 字符查询走 LIKE，结果一致。
- 服务集成：临时目录 + 假数据 → 请求 `/api/sessions`、`/api/session` 校验 JSON。

### 手动验收

1. `npm start` 打印 URL，浏览器可打开。
2. 列表数量符合“用户可见会话”规则：Claude 只算顶层 UUID（当前 52，不含 51 个子代理 transcript）；Codex 排除带 `parent_thread_id` / `agent_path` 的 fork（当前 21 − 3 = 18）；dsh 全部（当前 16）。数量会随使用增长，以规则为准。
3. agent chip、chat、cwd、搜索过滤均生效。
4. 打开任一会话，消息顺序、工具折叠正确。
5. 在某个会话文件末尾追加一行后，5s 内列表/详情更新。
6. `~/.session-hub/hub.db` 正常生成；删掉后重启能完整重建；源目录内容与 mtime 均未被修改（证明只读）。
7. `npm test` 全绿。

## 13. 留给 builder 的决定

- 具体视觉样式与配色。
- 搜索是否扩展到工具输出（默认不）。
- 大文件（>20MB）的逐块读取 / 截断策略。
- FTS 维护方式（写入事务里手工维护 vs 触发器）、WAL checkpoint 时机、是否需要 `VACUUM`。
- archived 会话默认显示还是折叠。
- 子代理 / fork transcript（Claude `agent-*.jsonl` 与 `<sessionId>/subagents/`，Codex 带 `parent_thread_id` 的 rollout）是否作为“相关会话”挂到父会话下；MVP 一律排除。
