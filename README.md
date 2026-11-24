# Session Hub

English | [中文](README.zh.md)

A **read-only** local dashboard that brings your AI agent sessions from Lark/Feishu and local WorkBuddy sessions together on one page:

- **Claude Code** sessions produced through [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (claude profile)
- **Codex** sessions produced by the same bridge (codex profile)
- **DeepSeek Harness (dsh)** sessions produced through [dsh-lark-channel](https://github.com/JunguangJiang/dsh-lark-channel)
- Local **WorkBuddy** sessions (CodeBuddy-based, by Tencent) stored under `~/.workbuddy`

## Read-only promise

This tool **never modifies, moves, or deletes files in any source directory**, and it makes no external network calls.

It only does three things:

1. Reads session files under `~/.claude`, `~/.codex`, `~/.dsh`, `~/.workbuddy`, and `~/.lark-channel`;
2. Writes parsed results into its own SQLite database at `~/.session-hub/hub.db` (directory mode 0700, database file mode 0600);
3. Serves a local web UI and JSON API on `127.0.0.1`.

Source files are only `stat`-ed and read. Incremental sync decides whether a file changed by its `mtime` + `size`.

## Requirements

- Node.js **≥ 22.5** (uses built-in `node:sqlite` and `node:zlib` zstd support; no third-party dependencies)
- At least one data source on this machine. Missing sources only produce warnings and do not affect the others.

## Usage

```bash
npm start
```

Open <http://127.0.0.1:7317>. The first start syncs immediately, then syncs incrementally every 5 seconds.

Rebuild the local copy completely (only clears `~/.session-hub/hub.db`; source directories are untouched):

```bash
npm start -- --rebuild
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SESSION_HUB_HOST` | `127.0.0.1` | Listen address; do not change to `0.0.0.0` unless necessary |
| `SESSION_HUB_PORT` | `7317` | Listen port |
| `SESSION_HUB_DB` | `~/.session-hub/hub.db` | Path to the local copy database |
| `CLAUDE_HOME` | `~/.claude` | Claude data root |
| `CODEX_HOME` | `~/.codex` | Codex data root |
| `DSH_HOME` | `~/.dsh` | dsh data root |
| `WORKBUDDY_HOME` | `~/.workbuddy` | WorkBuddy data root |
| `LARK_CHANNEL_HOME` | `~/.lark-channel` | Directory containing bridge profiles and chat mappings |

## Features

- Filter by agent and last-updated time
- The sidebar shows two collapsible sections, **Projects** and **Recent**. Projects are grouped by working directory (groups and sessions sorted by most recent update); Recent lists all sessions in reverse chronological order. Each session shows only its title, agent, and time
- All projects start collapsed. The open/closed state of the **Projects** and **Recent** sections and of each project is stored in browser localStorage, so it survives reloads and future visits
- Sessions with 0 messages and temporary sessions whose cwd is under `/tmp` or `/private/tmp` (including subdirectories) are hidden by default; pass `includeHidden=1` to the API to see them
- A **Settings** page at the bottom of the sidebar lets you toggle empty and temporary sessions independently, enable or disable supported agents, switch the interface language, and inspect the local database and source directories. Disabling an agent stops syncing and removes its local copy; re-enabling it reads the source files again
- The interface and all error messages are available in **Chinese and English**. The language follows your system language by default; you can override it in **Settings → Interface language** (System / 中文 / English)
- Full-text search (SQLite FTS5 trigram; automatically falls back to `LIKE` for queries shorter than 3 characters)
- Session detail: message order, thinking, tool calls, and tool results (collapsible). Messages, thinking, and tool content are rendered as Markdown, with automatic JSON indentation/formatting
- Markdown images in session content are shown inline. Relative paths (for example `![shot](shots/a.png)`) are resolved against the session's cwd and served read-only; files that no longer exist render as a deleted-image placeholder
- One-click copy buttons on every message and on each thinking, tool-call, and tool-result block (copies the original text, not the rendered HTML)
- Auxiliary sessions are excluded: Codex `onboarding_checklist` sessions do not appear in the session list
- WorkBuddy reasoning, tool calls, tool results, and AI titles are parsed; internal data such as `isMeta`, context compaction, `skipRun`, and aborted records is filtered out
- The session list refreshes automatically every 5 seconds, and the open detail view follows content changes
- Filters and the selected session are stored in the URL hash, so they survive a reload

## Data sources and parsing rules (summary)

| Source | Location | Notes |
| --- | --- | --- |
| Claude | `~/.claude/projects/<project>/<uuid>.jsonl` | Only top-level UUID session files; ignores `agent-*.jsonl` subagent records; title prefers `custom-title.json` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/*.jsonl` | Excludes subagents and forks identified by `parent_thread_id` / `forked_from_id` / `agent_path`, plus `thread_source: onboarding_checklist` auxiliary sessions; title comes from `thread_name` in `session_index.jsonl` |
| dsh | `~/.dsh/sessions/<slug>/<sessionDir>/session.v4.jsonl.zstd` | zstd-compressed v4 event stream; `lark-oc_*` directory names map back to Lark chats |
| WorkBuddy | `~/.workbuddy/projects/<project>/<uuid>.jsonl` | Streamed line by line; reasoning, tool calls, and results are grouped by `providerData.messageId`; `<system-reminder>` / `<user_query>` wrappers are removed; title comes from `ai-title`, falling back to the first user message; cwd comes from record fields rather than the directory name; system-generated directories such as `2026-10-02-11-25-23` are grouped under the virtual `workbuddy-default` project in the sidebar, while session details still show the original path |
| Chat mapping | `~/.lark-channel/profiles/{claude,codex}/sessions.json.catalog.json` | `scopeId` is the chat id; dsh derives it from directory names; WorkBuddy is a local app and is not linked to Lark chats |

> WorkBuddy's session format is not publicly documented, so fields may change after an upgrade. The parser skips malformed lines and unknown records. A single very large WorkBuddy session will be noticeably slower on first sync and first open.

## Privacy and security

- Session content may contain code, paths, secrets, and personal conversations. **Do not** expose this service to the public internet or forward it to others.
- The service binds only to `127.0.0.1` and has no authentication; it relies on local access control.
- All responses use `Cache-Control: no-store`; static file paths are protected against traversal.
- Session images are served only from inside the session's own working directory, and only for known image extensions; `..`, absolute paths outside it, symlinks, and other files are rejected.
- The local copy database directory uses mode `0700`; the database and its WAL/SHM files use `0600`.

## Tests

```bash
npm test
```

## Layout

```
src/
  config.js          Environment variables and default paths
  db.js              SQLite schema, session writes, queries, pruning, FTS
  settings.js        Read, validate, and persist local settings
  normalize.js       Text/time normalization
  sync.js            Incremental sync orchestration
  server.js          HTTP API + static files
  index.js           Entry point and background sync
  sources/
    claude.js        Claude session discovery and parsing
    codex.js         Codex rollout discovery and parsing
    dsh.js           dsh zstd session discovery and parsing
    workbuddy.js     WorkBuddy JSONL session discovery and parsing
    larkMap.js       Lark chat mapping
public/              Frontend dashboard
  i18n.js            Shared Chinese/English message catalog
  icons/             Icons for the four agents
```
