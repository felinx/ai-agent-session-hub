<p align="center">
  <img src="public/logo-banner-light.svg" alt="Agent Session Hub" width="720">
</p>

# Agent Session Hub

[English](README.md) | 中文

**AI 编码 Agent 越来越擅长干活，却越来越不方便让你事后看清它干了什么。** Claude Code、Codex、DeepSeek Harness、WorkBuddy 等工具各自把会话写进自己隐藏的目录和格式里，没有图形界面——终端一关，想找「那一次会话」就只能去 grep 一堆 JSONL。

Agent Session Hub 直接读取这些会话文件，解析成统一结构，再提供一个本地、**只读**的页面集中浏览、搜索和筛选。**不需要 bridge、插件，也不需要改 Agent 里的任何配置**——只要 Agent 把会话写到了本地，Session Hub 就能展示。

目前支持 Claude Code、Codex、DeepSeek Harness（dsh）与 WorkBuddy。来源列表是开放的：新增一个 Agent 只需要一个解析模块，看板、数据库、搜索与 API 都保持不变。

## 为什么需要 Agent Session Hub

### 1. 给只存在于 CLI 里的会话历史一个真正的界面

编码 Agent 是终端优先的：会话以 JSONL 藏在隐藏目录里，产生它的终端早已关闭。Session Hub 给这段历史一个正经的查看方式——消息、思考、工具调用与工具结果都在浏览器里渲染，支持全文搜索、按项目分组、筛选、一键复制、会话中提到的本地文件只读查看，以及稳定的内部 session id。不用往 Agent 里安装任何东西，它们本来写下的文件就够。

### 2. 多个 Agent 的会话放在一起看

同时用的 Agent 越多，工作就越分散在 Claude Code、Codex、dsh、WorkBuddy 以及以后出现的工具里。两天前在某个 Agent 里开的任务，很容易再也找不到。Session Hub 把各个来源聚合进同一个列表：按项目分组、按最近更新排序，「这个活当时是在哪个 Agent 里做的」一次搜索就能回答，而不是逐个翻各个 Agent 的目录。Agent、项目、时间和内容都可筛选，本地 SQLite 副本让跨 Agent 搜索也很快。

### 3. 多 Agent 共享上下文与任务调度的底座

单个 Agent 通常看不到其它 Agent 做过什么。一旦所有会话都被解析成同一种结构——带稳定 id、项目、Agent 和完整消息历史——Agent 之间共享上下文、在它们之间调度任务才真正可行：一个 Agent 可以查到另一个 Agent 已经试过什么，而不需要你手工搬运记录；调度器也能据此挑选更合适的 Agent 接手下一步。Session Hub 已经把底座做好（结构化的本地副本、稳定的 session id、只读 JSON API）；这些跨 Agent 的工作流是项目的方向，还不是现成功能。

## 支持的 Agent

每个来源都按 Agent 自己写的位置读取，不需要额外配置。

| Agent | 会话位置 | 解析内容 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<项目>/<uuid>.jsonl` | 只取顶层 UUID 会话文件；忽略 `agent-*.jsonl` 子代理记录；标题优先读 `custom-title.json` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`、`~/.codex/archived_sessions/*.jsonl` | 排除 `parent_thread_id` / `forked_from_id` / `agent_path` 的子代理与 fork，以及 `thread_source: onboarding_checklist` 的引导辅助会话；标题取 `session_index.jsonl` 的 `thread_name` |
| DeepSeek Harness（dsh） | `~/.dsh/sessions/<slug>/<sessionDir>/session.v4.jsonl.zstd` | zstd 压缩的 v4 事件流 |
| WorkBuddy | `~/.workbuddy/projects/<项目>/<uuid>.jsonl` | 逐行流式解析；按 `providerData.messageId` 聚合 reasoning、工具调用与结果；移除 `<system-reminder>` / `<user_query>` 包装；标题取 `ai-title`，缺失时回退首条用户消息；cwd 取自记录字段，不依赖目录名；形如 `2026-10-02-11-25-23` 的系统生成目录在侧边栏统一归入虚拟项目 `workbuddy-default`，会话详情仍显示原始路径 |

> WorkBuddy 的会话格式没有公开文档，升级后字段可能变化。解析器会跳过坏行和未知记录；单个超大 WorkBuddy 会话首次同步、首次打开会明显慢一些。

## 可选的飞书 bridge 支持（额外）

这些 Agent 都不依赖 bridge。但如果你恰好是通过 bridge 在飞书里和它们对话，Session Hub 会额外把会话和对应的飞书 chat 关联起来：

- [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（claude 与 codex profile）
- [dsh-lark-channel](https://github.com/JunguangJiang/dsh-lark-channel)

`~/.lark-channel` 存在时，会话会匹配到飞书 chat id，并显示在详情头部。映射规则：

| 来源 | chat id 的来源 |
| --- | --- |
| Claude / Codex | `~/.lark-channel/profiles/{claude,codex}/sessions.json.catalog.json` 中的 `scopeId` |
| dsh | 从 `lark-oc_*` 会话目录名推导 |
| WorkBuddy | 本地应用，不关联飞书 chat |

没有 bridge 也完全不影响使用——会话只是显示为本地会话。bridge 的目录只读不写。

## 只读承诺

本工具**不会修改、移动或删除任何源目录里的文件**，也不调用任何外部网络服务。

它只做三件事：

1. 读取 `~/.claude`、`~/.codex`、`~/.dsh`、`~/.workbuddy`，以及（存在时）`~/.lark-channel` 下的会话文件；
2. 把解析结果写进自己独立的 SQLite 数据库 `~/.session-hub/hub.db`（目录 0700，数据库文件 0600）；
3. 在 `127.0.0.1` 上提供本地网页与 JSON API。

源文件只被 `stat` 和读取；增量同步依据文件 `mtime` + `size` 判断是否变化。

## 前置条件

- Node.js **≥ 22.5**（使用内置 `node:sqlite` 与 `node:zlib` 的 zstd 支持，无第三方依赖）
- 本机存在至少一个 Agent 的数据目录；缺失的来源只会产生警告，不影响其它来源。

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
| `CLAUDE_HOME` | `~/.claude` | Claude Code 数据根目录 |
| `CODEX_HOME` | `~/.codex` | Codex 数据根目录 |
| `DSH_HOME` | `~/.dsh` | dsh 数据根目录 |
| `WORKBUDDY_HOME` | `~/.workbuddy` | WorkBuddy 数据根目录 |
| `LARK_CHANNEL_HOME` | `~/.lark-channel` | 可选；仅用于把会话关联回飞书 chat |

## 功能

- 按 Agent / 更新时间筛选
- 侧边栏同时展示「项目」与「最近」两个可折叠区块：项目按工作目录分组（组间与组内均按最近更新倒序），最近为全部会话倒序；每个会话只显示标题、Agent 与时间
- 项目默认全部收起；「项目」「最近」区块与每个项目的展开/收起状态保存在浏览器 localStorage，刷新页面或下次打开时保持
- 默认隐藏 0 条消息的空会话，以及 cwd 位于 `/tmp`、`/private/tmp`（含子目录）的临时会话；API 加 `includeHidden=1` 可查看
- 侧边栏底部「设置」页：可分别开关空会话与临时目录会话、启用/停用各个 Agent、切换界面语言、查看本地数据库与各来源目录；停用 Agent 后会停止同步并移除其本地副本，重新启用会再次读取源文件
- 设置旁的「状态」页按 Agent 汇总会话数、消息数、最近同步时间，并展示最近一条会话的内部 ID 与最新消息的单行摘要；点击即可打开该会话
- 每个会话都有稳定的内部 **session id**（由会话 key 派生的 8 位十六进制串，`--rebuild` 后不变），详情页头部会展示
- 后台同步只为发生变化的会话各打一行日志：`+ [agent] <session-id> <摘要>`，会话从来源消失时打一行删除记录；没有变化时不输出，整体情况看「状态」页
- 界面与错误提示支持**中文和英文**。默认跟随系统语言，可在「设置 → 界面语言」中改为跟随系统、中文或 English
- 全文搜索（SQLite FTS5 trigram；少于 3 个字符时自动回退到 `LIKE`）
- 会话详情：消息顺序、thinking、工具调用与工具结果（折叠展示）；消息、思考与工具内容按 Markdown 渲染，JSON 内容自动缩进格式化
- 会话中的 Markdown 图片会直接显示；相对路径（如 `![截图](shots/a.png)`）按会话的 cwd 解析并以只读方式提供，文件已删除时显示占位样式
- **不会**自动加载远程图片（如 shields.io 徽章），而是渲染成可点击的小徽章，点开在新标签页查看原图，不会把访问暴露给第三方
- 会话里提到的本地文件（如 `[cordis.patch.yml:58-62](/Users/me/app/cordis.patch.yml#L58-L62)`）可点击，在只读文件查看器中带行号展示；`#L58-L62` 片段会高亮并滚动到对应行范围。相对路径按会话的 cwd 解析
- 每条消息，以及消息内的思考、工具调用、工具结果都提供一键复制按钮（复制原始文本，不复制渲染后的 HTML）
- 每 5 秒自动刷新会话列表，详情随会话内容变化刷新
- 过滤条件与选中会话记录在 URL hash，刷新后保留

## 隐私与安全

- 会话内容可能包含代码、路径、密钥、个人对话。**不要**把本服务暴露到公网或转发给他人。
- 服务只绑定 `127.0.0.1`，没有登录鉴权，依靠本机访问控制。
- 所有响应带 `Cache-Control: no-store`；静态文件路径做了穿越防护。
- 页面引用的静态资源（CSS、JS、logo、favicon）会自动附加内容哈希 `?v=`，文件一改就能绕过浏览器与 favicon 缓存。
- 严格的 CSP 将页面限制在同源：不加载任何外部脚本、样式、字体或图片，会话里的远程图片只作为链接存在。
- 会话图片只允许来自该会话自己的工作目录，且仅限已知图片扩展名；`..`、目录外的绝对路径、符号链接与其它文件一律拒绝。
- 文件查看器只读取你点击的本地文件：文本上限 1 MB，二进制内容只提示不展示，也没有写入或上传通道。由于服务只在本机运行且没有鉴权，当前用户可读的任意本地文件都能通过 `/api/file` 打开——请务必只监听 `127.0.0.1`。
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
  settings.js        本地设置的读取、校验与保存
  normalize.js       文本/时间归一化、单行摘要
  session-id.js      由会话 key 派生的稳定内部 session id
  log.js             带时间戳的同步变更日志
  sync.js            增量同步编排
  server.js          HTTP API + 静态文件（图片/文件接口、资源版本号）
  index.js           入口与后台同步
  sources/
    claude.js        Claude 会话发现与解析
    codex.js         Codex rollout 发现与解析
    dsh.js           dsh zstd 会话发现与解析
    workbuddy.js     WorkBuddy JSONL 会话发现与解析
    larkMap.js       飞书 chat 映射（可选）
public/              前端看板
  i18n.js            中英文共享文案目录
  format.js          Markdown 子集渲染（先转义再格式化）
  links.js           本地文件链接识别与查看页地址
  images.js          会话图片路径解析为图片接口地址
  app.js             会话列表、详情、设置、状态
  viewer.html/.js    只读文件查看器（带行号）
  icons/             Agent 图标
  logo-banner-light.svg  README 顶部横幅
```

## 许可证

[Apache License 2.0](LICENSE) — Copyright (c) 2026 Agent Session Hub。

各 Agent 名称与图标归其各自所有者，仅用于标识。
