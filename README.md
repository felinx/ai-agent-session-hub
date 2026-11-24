<p align="center">
  <img src="public/logo-banner-light.svg" alt="Agent Session Hub" width="720">
</p>

# Agent Session Hub

English | [中文](README.zh.md)

**AI coding agents are getting better at doing the work and worse at letting you see it afterwards.** Claude Code, Codex, DeepSeek Harness, WorkBuddy and their peers each write sessions into their own hidden directory and format, with no graphical browser — once the terminal closes, finding "that one session" means grepping JSONL.

Agent Session Hub reads those session files directly, parses them into one structure, and serves a single local, **read-only** page for browsing, searching, and filtering all of them. It needs **no bridge, plugin, or configuration inside the agents** — if the agent wrote its session files, Session Hub can show them.

Today it understands Claude Code, Codex, DeepSeek Harness (dsh), and WorkBuddy. The source list is deliberately open: adding another agent is one parser module, and the dashboard, database, search, and API stay the same.

## Why Agent Session Hub

### 1. A real interface for session history that only exists in CLIs

Coding agents are terminal-first: sessions live as JSONL files in hidden directories, and the terminal that produced them is gone. Session Hub gives that history a proper view — messages, thinking, tool calls, and tool results rendered in the browser, with full-text search, project grouping, filters, copy buttons, a read-only file viewer for paths mentioned in sessions, and stable internal session ids. Nothing to install into the agents; the files they already write are enough.

### 2. One place for all of your agents

The more agents you run, the more your work spreads across Claude Code, Codex, dsh, WorkBuddy, and whatever comes next. A task started in one agent two days ago is easy to lose. Session Hub aggregates every source into one list grouped by project and sorted by recency, so you can answer "which agent was I using for this?" with one search instead of opening each agent's directory. Agent, project, time, and content are all filterable, and the local SQLite copy makes cross-agent search fast.

### 3. A shared foundation for working across agents

A single agent rarely sees what the others did. Once every session is parsed into the same structure — with a stable id, project, agent, and message history — sharing context between agents and routing tasks between them become tractable: one agent can look up what another already tried instead of you pasting transcripts around, and a scheduler can pick the agent best suited to the next task. Session Hub already provides the substrate for this (structured local copies, stable ids, a read-only JSON API); the cross-agent workflows themselves are the direction the project is built for, not a finished feature.

## Supported agents

Each source is read where its agent writes it; nothing else is required.

| Agent | Where sessions live | What is parsed |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<project>/<uuid>.jsonl` | Only top-level UUID session files; `agent-*.jsonl` subagent records are ignored; title prefers `custom-title.json` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `~/.codex/archived_sessions/*.jsonl` | Subagents and forks (`parent_thread_id` / `forked_from_id` / `agent_path`) and `thread_source: onboarding_checklist` sessions are excluded; title comes from `thread_name` in `session_index.jsonl` |
| DeepSeek Harness (dsh) | `~/.dsh/sessions/<slug>/<sessionDir>/session.v4.jsonl.zstd` | zstd-compressed v4 event stream |
| WorkBuddy | `~/.workbuddy/projects/<project>/<uuid>.jsonl` | Streamed line by line; reasoning, tool calls, and results are grouped by `providerData.messageId`; `<system-reminder>` / `<user_query>` wrappers are removed; title comes from `ai-title`, falling back to the first user message; cwd comes from record fields rather than the directory name; system-generated directories such as `2026-10-02-11-25-23` are grouped under the virtual `workbuddy-default` project, while session details still show the original path |

> WorkBuddy's session format is not publicly documented, so fields may change after an upgrade. The parser skips malformed lines and unknown records. A single very large WorkBuddy session will be noticeably slower on first sync and first open.

## Optional: Lark/Feishu bridges (extra)

None of the supported agents needs a bridge. But if you happen to talk to them through one, Session Hub picks up the chat linkage as a bonus:

- [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (claude and codex profiles)
- [dsh-lark-channel](https://github.com/JunguangJiang/dsh-lark-channel)

When `~/.lark-channel` exists, sessions are matched to their Lark chat id and show it in the detail header. Mapping rules:

| Source | How the chat id is found |
| --- | --- |
| Claude / Codex | `~/.lark-channel/profiles/{claude,codex}/sessions.json.catalog.json` — `scopeId` is the chat id |
| dsh | Derived from the `lark-oc_*` session directory names |
| WorkBuddy | A local app; never linked to a Lark chat |

Without a bridge nothing breaks — sessions simply show as local sessions. The bridge files are read, never written.

## Read-only promise

This tool **never modifies, moves, or deletes files in any source directory**, and it makes no external network calls.

It only does four things:

1. Reads session files under `~/.claude`, `~/.codex`, `~/.dsh`, `~/.workbuddy`, and (when present) `~/.lark-channel`;
2. Writes parsed results into its own SQLite database at `~/.session-hub/hub.db` (directory mode 0700, database file mode 0600);
3. Writes its own log files under `~/.session-hub/logs` (directory mode 0700, files mode 0600);
4. Serves a local web UI and JSON API on `127.0.0.1`.

Source files are only `stat`-ed and read. Incremental sync decides whether a file changed by its `mtime` + `size`.

## Requirements

- Node.js **≥ 22.5** (uses built-in `node:sqlite` and `node:zlib` zstd support; no third-party dependencies)
- At least one supported agent's data directory on this machine. Missing sources only produce warnings and do not affect the others.

## Usage

```bash
npm start               # run the hub in the foreground
npm start -- --rebuild  # same, rebuilding the local copy first
```

Open <http://127.0.0.1:7317>. The first start syncs immediately, then syncs incrementally every 5 seconds.

For daily use, run it in the background instead — it keeps running after the terminal closes:

```bash
node bin/session-hub.js start     # background daemon; prints pid and URL
node bin/session-hub.js status    # exit 0 when running, 1 when stopped; --json for scripts
node bin/session-hub.js logs -f   # follow the log files (-n N for a tail, --clear to reset)
node bin/session-hub.js stop
node bin/session-hub.js restart
node bin/session-hub.js doctor    # check Node, local copy, logs, sources, and server
```

`npm link` (or `npm install -g .`) puts `session-hub` on your PATH, so the commands above become `session-hub start`, `session-hub status`, and so on. Running `session-hub` with no command starts the background daemon.

The daemon needs no service manager: it keeps a pid file at `~/.session-hub/hub.pid`, and `stop` only signals the process recorded there (SIGTERM, then SIGKILL if it does not exit). `status` answers from the running server when there is one and reads the local copy directly when there is not, so it works whether or not the daemon is up.

### Logs

Every changed session produces one line in `~/.session-hub/logs/hub-YYYY-MM-DD.log`. Files rotate daily, roll to `.1`, `.2`, … once a file reaches 10 MB, and files older than 30 days are deleted. The directory is `0700` and the files `0600`. Because those lines carry session ids and one-line summaries of session content, treat the log files with the same care as the sessions themselves. `SESSION_HUB_LOG_DIR` moves them elsewhere.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SESSION_HUB_HOST` | `127.0.0.1` | Listen address; do not change to `0.0.0.0` unless necessary |
| `SESSION_HUB_PORT` | `7317` | Listen port |
| `SESSION_HUB_DB` | `~/.session-hub/hub.db` | Path to the local copy database |
| `SESSION_HUB_LOG_DIR` | `~/.session-hub/logs` | Directory for the rotating log files |
| `CLAUDE_HOME` | `~/.claude` | Claude Code data root |
| `CODEX_HOME` | `~/.codex` | Codex data root |
| `DSH_HOME` | `~/.dsh` | dsh data root |
| `WORKBUDDY_HOME` | `~/.workbuddy` | WorkBuddy data root |
| `LARK_CHANNEL_HOME` | `~/.lark-channel` | Optional; only used to map sessions back to Lark chats |

## Features

- Filter by agent and last-updated time
- The sidebar shows two collapsible sections, **Projects** and **Recent**. Projects are grouped by working directory (groups and sessions sorted by most recent update); Recent lists all sessions in reverse chronological order. Each session shows only its title, agent, and time
- All projects start collapsed. The open/closed state of the **Projects** and **Recent** sections and of each project is stored in browser localStorage, so it survives reloads and future visits
- Sessions with 0 messages and temporary sessions whose cwd is under `/tmp` or `/private/tmp` (including subdirectories) are hidden by default; pass `includeHidden=1` to the API to see them
- A **Settings** page at the bottom of the sidebar lets you toggle empty and temporary sessions independently, enable or disable each agent, switch the interface language, and inspect the local database and source directories. Disabling an agent stops syncing and removes its local copy; re-enabling it reads the source files again
- A **Status** page next to Settings summarises every agent: session and message counts, the latest sync time, and for the newest session its internal id and a one-line summary of the latest message. Clicking it opens that session
- Every session carries a stable internal **session id** (8 hex characters derived from the session key, so it survives `--rebuild`); the detail header shows it next to the agent
- The background sync logs one line per changed session, `+ [agent] <session-id> <summary>`, and one line when a session disappears. Syncs that changed nothing print nothing — the Status page covers the overall picture. The same lines go to the rotating log files under `~/.session-hub/logs/`
- The interface and all error messages are available in **Chinese and English**. The language follows your system language by default; you can override it in **Settings → Interface language** (System / 中文 / English)
- Full-text search (SQLite FTS5 trigram; automatically falls back to `LIKE` for queries shorter than 3 characters)
- Session detail: message order, thinking, tool calls, and tool results (collapsible). Messages, thinking, and tool content are rendered as Markdown, with automatic JSON indentation/formatting
- Markdown images in session content are shown inline. Relative paths (for example `![shot](shots/a.png)`) are resolved against the session's cwd and served read-only; files that no longer exist render as a deleted-image placeholder
- Remote images (for example shields.io badges) are **not** loaded automatically. They render as a small clickable badge that opens the original in a new tab, so no third-party host sees the visit
- Local file paths in session content (for example `[cordis.patch.yml:58-62](/Users/me/app/cordis.patch.yml#L58-L62)`) open in a read-only file viewer with line numbers; a `#L58-L62` fragment highlights and scrolls to that range. Relative paths resolve against the session's cwd
- One-click copy buttons on every message and on each thinking, tool-call, and tool-result block (copies the original text, not the rendered HTML)
- The session list refreshes automatically every 5 seconds, and the open detail view follows content changes
- Filters and the selected session are stored in the URL hash, so they survive a reload

## Privacy and security

- Session content may contain code, paths, secrets, and personal conversations. **Do not** expose this service to the public internet or forward it to others.
- The service binds only to `127.0.0.1` and has no authentication; it relies on local access control.
- All responses use `Cache-Control: no-store`; static file paths are protected against traversal.
- Assets referenced from the HTML pages (CSS, JS, logo, favicons) get a content-hash `?v=` query, so changing a file also busts browser and favicon caches.
- A strict CSP keeps the page same-origin: no external scripts, styles, fonts, or images are loaded, and remote images in sessions are links instead of requests.
- Session images are served only from inside the session's own working directory, and only for known image extensions; `..`, absolute paths outside it, symlinks, and other files are rejected.
- The file viewer reads only local files you click: text is capped at 1 MB, binary content is reported but not displayed, and there is no write or upload path. Because the service is local-only and unauthenticated, any local file readable by your user can be opened through `/api/file` — keep the port on `127.0.0.1`.
- The local copy database directory uses mode `0700`; the database and its WAL/SHM files use `0600`.
- Hub logs contain session ids and one-line session summaries. Their directory is `0700` and each file `0600`; keep them as private as the sessions they describe.

## Tests

```bash
npm test
```

## Layout

```
bin/
  session-hub.js     CLI entry point
src/
  args.js            Hand-rolled command-line parsing
  cli.js             Command dispatch: run, start, stop, restart, status, logs, doctor
  hub.js             Server and sync lifecycle
  daemon.js          Detached background process, pid file, liveness checks
  status.js          Live-or-local status collection and formatting
  logs.js            Tail, follow, and clear the rotating log files
  log-file.js        Rotating log store (daily files, size cap, retention)
  doctor.js          Read-only environment checks
  config.js          Environment variables and default paths
  db.js              SQLite schema, session writes, queries, pruning, FTS
  settings.js        Read, validate, and persist local settings
  normalize.js       Text/time normalization, one-line summaries
  session-id.js      Stable internal session id derived from the session key
  log.js             Timestamped sync change log lines
  sync.js            Incremental sync orchestration
  server.js          HTTP API + static files (image and file endpoints, asset versions)
  index.js           Compatibility entry point; runs in the foreground
  sources/
    claude.js        Claude session discovery and parsing
    codex.js         Codex rollout discovery and parsing
    dsh.js           dsh zstd session discovery and parsing
    workbuddy.js     WorkBuddy JSONL session discovery and parsing
    larkMap.js       Lark chat mapping (optional)
public/              Frontend dashboard
  i18n.js            Shared Chinese/English message catalog
  format.js          Markdown subset renderer (escapes first, then formats)
  links.js           Local-file link detection and viewer URLs
  images.js          Resolves session image paths to the asset endpoint
  app.js             Session list, detail, settings, status
  viewer.html/.js    Read-only file viewer with line numbers
  icons/             Agent icons
  logo-banner-light.svg  Banner shown at the top of this README
```

## License

[Apache License 2.0](LICENSE) — Copyright (c) 2026 Agent Session Hub.

Agent names and icons belong to their respective owners and are used for identification only.
