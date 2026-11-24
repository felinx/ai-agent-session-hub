# Session Hub

一个**只读**的本机看板，把你在飞书里用过的三类 AI Agent 会话聚合到同一个页面：

- 通过 [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 产生的 **Claude Code** 会话（claude profile）
- 同一个 bridge 产生的 **Codex** 会话（codex profile）
- 通过 [dsh-lark-channel](https://github.com/JunguangJiang/dsh-lark-channel) 产生的 **DeepSeek Harness (dsh)** 会话

## 只读承诺

本工具**不会修改、移动或删除任何源目录里的文件**，也不调用任何外部网络服务。

它只做三件事：

1. 读取 `~/.claude`、`~/.codex`、`~/.dsh`、`~/.lark-channel` 下的会话文件；
2. 把解析结果写进自己独立的 SQLite 数据库 `~/.session-hub/hub.db`（目录 0700，数据库文件 0600）；
3. 在 `127.0.0.1` 上提供本地网页与 JSON API。

源文件只被 `stat` 和读取；增量同步依据文件 `mtime` + `size` 判断是否变化。

## 前置条件

- Node.js **≥ 22.5**（使用内置 `node:sqlite` 与 `node:zlib` 的 zstd 支持，无第三方依赖）
- 本机存在至少一个数据来源；缺失的来源只会产生警告，不影响其它来源。

## 使用

```bash
npm start
```

默认打开 <http://127.0.0.1:7317>。首次启动会立即同步一次，之后每 5 秒增量同步。

完全重建本地副本（只清空 `~/.session-hub/hub.db`，不碰源目录）：

```bash
npm start -- --rebuild
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SESSION_HUB_HOST` | `127.0.0.1` | 监听地址；非必要不要改成 `0.0.0.0` |
| `SESSION_HUB_PORT` | `7317` | 监听端口 |
| `SESSION_HUB_DB` | `~/.session-hub/hub.db` | 本地副本数据库路径 |
| `CLAUDE_HOME` | `~/.claude` | Claude 数据根目录 |
| `CODEX_HOME` | `~/.codex` | Codex 数据根目录 |
| `DSH_HOME` | `~/.dsh` | dsh 数据根目录 |
| `LARK_CHANNEL_HOME` | `~/.lark-channel` | bridge profile 与 chat 映射所在目录 |

## 功能

- 按 Agent / 更新时间筛选
- 侧边栏同时展示「项目」与「最近」两个可折叠区块：项目按工作目录分组（组间与组内均按最近更新倒序），最近为全部会话倒序；每个会话只显示标题、Agent 与时间
- 项目默认全部收起；「项目」「最近」区块与每个项目的展开/收起状态保存在浏览器 localStorage，刷新页面或下次打开时保持
- 默认隐藏 0 条消息的空会话，以及 cwd 位于 `/tmp`、`/private/tmp`（含子目录）的临时会话；API 加 `includeHidden=1` 可查看
- 全文搜索（SQLite FTS5 trigram；少于 3 个字符时自动回退到 `LIKE`）
- 会话详情：消息顺序、thinking、工具调用与工具结果（折叠展示）；消息、思考与工具内容按 Markdown 渲染，JSON 内容自动缩进格式化
- 排除辅助会话：Codex 的 `onboarding_checklist`（首次引导清单）不出现在会话列表中
- 每 5 秒自动刷新会话列表，详情随会话内容变化刷新
- 过滤条件与选中会话记录在 URL hash，刷新后保留

## 数据来源与解析规则（摘要）

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| Claude | `~/.claude/projects/<项目>/<uuid>.jsonl` | 只取顶层 UUID 会话文件；忽略 `agent-*.jsonl` 子代理记录；标题优先读 `custom-title.json` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`、`~/.codex/archived_sessions/*.jsonl` | 排除 `parent_thread_id` / `forked_from_id` / `agent_path` 的子代理与 fork，以及 `thread_source: onboarding_checklist` 的引导辅助会话；标题取 `session_index.jsonl` 的 `thread_name` |
| dsh | `~/.dsh/sessions/<slug>/<sessionDir>/session.v4.jsonl.zstd` | zstd 压缩的 v4 事件流；`lark-oc_*` 目录名映射回飞书 chat |
| chat 映射 | `~/.lark-channel/profiles/{claude,codex}/sessions.json.catalog.json` | `scopeId` 即 chat id；dsh 从目录名提取 |

## 隐私与安全

- 会话内容可能包含代码、路径、密钥、个人对话。**不要**把本服务暴露到公网或转发给他人。
- 服务只绑定 `127.0.0.1`，没有登录鉴权，依靠本机访问控制。
- 所有响应带 `Cache-Control: no-store`；静态文件路径做了穿越防护。
- 本地副本数据库目录权限 `0700`、数据库及 WAL/SHM 文件 `0600`。

## 测试

```bash
npm test
```

## 结构

```
src/
  config.js          环境变量与默认路径
  db.js              SQLite schema、会话写入、查询、清理、FTS
  normalize.js       文本/时间归一化
  sync.js            增量同步编排
  server.js          HTTP API + 静态文件
  index.js           入口与后台同步
  sources/
    claude.js        Claude 会话发现与解析
    codex.js         Codex rollout 发现与解析
    dsh.js           dsh zstd 会话发现与解析
    larkMap.js       飞书 chat 映射
public/              前端看板
  icons/             三个 Agent 的图标
```
