# Session event subscription interface

Status: draft — design only, not implemented.

## Summary

Downstream consumers (other agents, schedulers, scripts, dashboards) should be able to
react to session changes without polling the full session list. This document proposes a
durable event log with a monotonic cursor, served over two read-only HTTP channels: a
long-polling endpoint as the primary transport and Server-Sent Events (SSE) for live
streaming. Webhooks are explicitly out of scope.

The design keeps the project's constraints: zero third-party dependencies, a local
read-only HTTP API bound to `127.0.0.1`, no outbound network calls, and source session
files untouched.

## Goals

- Let a downstream consumer ask "what changed since cursor N?" and receive every change
  at least once, even across hub restarts or consumer disconnects.
- Keep most events small: session events carry metadata plus a one-line summary. The one
  exception is `turn.completed`, which carries the full text of the two messages that
  matter most — the human prompt and the agent's final answer — so a consumer can act
  without a follow-up fetch. Intermediate reasoning, tool calls, and tool output never
  enter the event stream; they are served by the turn-content endpoints.
- Support both modes downstream agents actually use: a long-lived stream (SSE) and a
  simple blocking poll that any HTTP client or shell script can drive.
- Avoid an event storm during the initial full sync, while still making bootstrap
  correct and race-free.

## Non-goals

- Webhooks or any consumer-registered callback URL. Consumers are local; callbacks would
  add registration, retries, authentication, and SSRF surface for no benefit.
- Delivery of message-level events. The unit of change is a session; the only message
  text in the feed is the prompt and final answer carried by `turn.completed` (see
  [Payload policy](#payload-policy)).
- Consumer-side processing state ("pending"/"done"/acknowledged work queues). This is a
  change feed, not a task queue.
- Multi-hub aggregation. The pid file already enforces one hub per database directory.
- Cross-machine or public exposure.

## Why this shape

| Option | Survives restarts | Consumer cost | Risks | Decision |
| --- | --- | --- | --- | --- |
| Durable event table + `since` cursor over HTTP | Yes | One GET | Large `turn.completed` payloads need a byte budget | **Primary transport** |
| SSE endpoint on the same cursor | Yes (`Last-Event-ID`) | `fetch` stream | Slow-client backpressure | **Live transport** |
| Webhook callbacks | Needs retry machinery | Consumer must serve HTTP | SSRF, auth, offline failures | Not built |
| Filesystem outbox (`events.jsonl` + `tail -f`) | Yes | Read a file | Rotation/truncation semantics | Optional P3 |
| MCP server | Via the same cursor | Native tool calls | Larger implementation | P2 |

The event table is the source of truth. Both transports read from it, so they share one
cursor model and one payload schema. A consumer that misses a stream window can resume
with the last `seq` it saw, regardless of which transport delivered it.

## Event model

Every event shares a versioned envelope. Payload size depends on the event type:
session events are small, `turn.completed` is deliberately large.

```json
{
  "v": 1,
  "seq": 1287,
  "type": "session.updated",
  "at": 1764000000000,
  "session": {
    "key": "claude:9f3c2a1e-…",
    "id": "517479a5",
    "agent": "claude",
    "project": "ai-agent-session-hub",
    "cwd": "/Users/me/src/ai-agent-session-hub",
    "title": "Optimize CLI startup and logging",
    "messageCount": 42,
    "updatedAt": 1763999998000,
    "summary": "Turned the log into dated rotating files…",
    "lastMessageSeq": 41,
    "archived": false
  }
}
```

- `seq` — monotonically increasing integer assigned by the database. It never repeats and
  never depends on timestamps, file mtimes, or wall-clock ordering. It is the cursor.
- `type` — one of:
  - `session.created` — a session appeared in the local copy.
  - `session.updated` — an existing session was re-parsed and written.
  - `session.removed` — the source file disappeared and the copy was pruned. Carries only
    the key, id, agent, and timestamp.
  - `sync.completed` — one event per sync pass, carrying `added`, `updated`, `removed`,
    and the resulting `seq`. Lets consumers batch work per sync instead of reacting to
    every row.
  - `turn.completed` — one human request and the agent's full answer are finished; see
    [Turn completion](#turn-completion). This is the event to react to when a consumer
    cares about a settled answer rather than an intermediate file change.
- `session.summary` — the same one-line summary the CLI log already prints
  (`latestSummary()` in `src/sync.js`, limited to 80 characters via `oneLine`).
- `session.lastMessageSeq` — the sequence number of the newest message in the copy, so a
  consumer can fetch just the new messages instead of the whole session.
- `project` — derived from the session cwd (or the existing virtual grouping). Included
  because downstream coordination is usually project-scoped.
- `v` — payload version. Adding optional fields does not bump it; changing field meaning
  does.

### Payload policy

- **Two messages are carried in full, per turn.** `turn.completed` includes the complete
  text of the human prompt (`turn.prompt.text`) and of the agent's terminal message
  (`turn.final.text`). They are the text as stored in the local copy, after the existing
  normalization (bridge/system wrappers stripped, synthetic messages dropped), and they
  are never truncated. Attachments, images, and tool output are not inlined.
- **The middle of a turn is summarized only.** Session events carry an 80-character
  `summary`; `turn.completed` carries no reasoning, no intermediate assistant text, no
  tool arguments, and no tool output. The event stream is not a transcript.
- **Everything else is fetched on demand.** Full intermediate content, or every message
  of a turn including the prompt and final answer, comes from the turn-content endpoints
  described in [Content access](#content-access). Consumers that only need the two
  endpoint messages never call them.
- **Large events are expected and accepted.** A final answer can be tens of kilobytes; a
  prompt can be a long pasted document. The events table stores these payloads and
  inherits the privacy and retention rules of the rest of the copy. This is the deliberate
  trade-off for letting a downstream agent react without a second request.

A consumer that needs content beyond `prompt.text` and `final.text` calls
`GET /api/turn/messages?key=…&turn=…`; `GET /api/session?key=…` still returns the whole
session when that is simpler.

## Turn completion

A `session.updated` event only says "the copy changed". During one question the file
changes many times — reasoning, tool calls, tool results, intermediate assistant text —
so a consumer reacting to `updated` sees the middle of a turn, not the answer. This
section defines a turn, how each source marks its end, and the `turn.completed` event.

### What a turn is

- It starts with a real human prompt. Tool-result-only user entries, `developer`
  messages, injected context, compaction summaries, and subagent sidechains are not
  prompts.
- It includes everything the agent did for that prompt: reasoning, tool calls and
  results, and any intermediate assistant messages.
- It ends when the agent stops for that prompt — a final answer, an error, a block, or
  an abort. Intermediate tool use is not the end.
- `turnSeq` is a per-session ordinal assigned by the hub (`1..N`, persisted), so
  consumers do not depend on source-specific ids. `turnId` is the source's own id where
  one exists.

### Signals per source

| Source | Turn start | Turn end | Status |
| --- | --- | --- | --- |
| Claude | User entry whose content is not only `tool_result`, not synthetic, not `isSidechain` | Assistant entry with a terminal `message.stop_reason`: `end_turn`, `stop_sequence`, or `max_tokens`. `tool_use` is **not** terminal. One message is split across up to 8 lines sharing `message.id`; group by id and read the terminal reason from the last group | `completed` / `truncated` (`max_tokens`) |
| Codex | `event_msg` with `payload.type === "task_started"` | `event_msg` with `payload.type === "task_complete"`, carrying `turn_id` and `last_agent_message`; pair by `turn_id` | `completed`; a new `task_started` without a preceding `task_complete` closes the old turn as `interrupted` |
| dsh | `turn/start` (`data.turn`) | `turn/end`; `data.reason.kind` is `completed`, `blocked`, `aborted`, or `error` | mapped one-to-one |
| WorkBuddy | `message` with `role: "user"` and `providerData.startsNewUserRequest !== false` | No native marker — inferred, see below | `completed` / `aborted` / `interrupted` |

Status normalization: `completed` means the agent produced its final answer;
`truncated` means it stopped at a length limit; `error`, `blocked`, `aborted` are
source-reported failures; `interrupted` means the hub inferred that the process or the
user stopped the turn without a terminal marker.

Interruption is conservative: the hub declares `interrupted` only when a new prompt
arrives and nothing follows it (the process died before answering), or the file ends with
an unresolved tool call after the settle window. A user message that is followed by more
assistant or tool activity is an intermediate message inside the same turn, not a new
turn.

### WorkBuddy (inferred)

WorkBuddy persists no turn-complete record. `turnComplete` and `task_completed` exist
only in the app's i18n and telemetry, never in the JSONL transcript. The transcript is
append-only, and one model step writes, in order: optional `reasoning`, the assistant
`message` text, then any `function_call` entries — all sharing the same
`providerData.messageId`; `function_call_result` follows after execution.

Findings across 71 sessions (2026-11-24):

- 6156 of 6632 completed assistant text messages are mid-turn; 5917 of those have
  `function_call` entries with the same `messageId`, and those calls are always written
  **after** the text.
- Every completed assistant message *without* a same-`messageId` `function_call` is
  followed only by a compaction summary or the next prompt — never by more work in the
  same turn.
- A turn's `providerData.conversationRequestId` is constant within the turn and changes
  at each `startsNewUserRequest`.
- Aborts end with an assistant message whose `status` is `incomplete` and whose
  `providerData.error.message` is, for example, `Interrupted by user`. A killed process
  can instead leave an unresolved `function_call` as the last entry.

Inference rules:

1. Split at `startsNewUserRequest` messages; ignore compaction entries
   (`isCompactInternal`, `isCompacted`, `<cb_summary>` / `<conversation_history_summary>`
   user messages) and `skipRun` / `isMeta` records.
2. A turn is terminal when its last visible item is an assistant `message` with
   `status: "completed"` and the turn contains no `function_call` with the same
   `messageId`.
3. Do not emit immediately: the text and its tool calls are separate appends, so require
   the file to be unchanged for at least one sync interval (5s) before closing the turn.
   Without this, a sync that lands between the two appends would close a turn that has
   pending tool calls.
4. `status: "incomplete"` plus `providerData.error` ends the turn as `aborted`.
5. A prompt followed by no further assistant or tool activity, or EOF with an unresolved
   `function_call`, ends the previous turn as `interrupted`; a prompt followed by more
   activity is an intermediate user message inside the same turn.

Events derived this way carry `signal: "inferred"`; the other three sources carry
`signal: "native"`. Consumers that need certainty can ignore inferred completions, at
the cost of WorkBuddy support.

### Event shape

```json
{
  "v": 1,
  "seq": 1290,
  "type": "turn.completed",
  "at": 1764000000000,
  "turn": {
    "sessionKey": "claude:9f3c2a1e-…",
    "turnSeq": 7,
    "turnId": "msg_92a1c48ce0df4841886a1411ba00f385",
    "status": "completed",
    "signal": "native",
    "startedAt": 1763999800000,
    "endedAt": 1763999998000,
    "promptSeq": 41,
    "finalSeq": 47,
    "prompt": {
      "seq": 41,
      "at": 1763999800000,
      "role": "user",
      "text": "把 CLI 启动和日志改成……（完整原文，不截断）"
    },
    "final": {
      "seq": 47,
      "at": 1763999998000,
      "role": "assistant",
      "text": "已经改完：……（完整原文，不截断）"
    },
    "summary": "检查了行数与章节结构，与原文一致。"
  }
}
```

- `prompt.text` and `final.text` are the complete message texts, exactly as stored in the
  local copy after normalization, with no character or byte limit. This is the point of
  the event: a downstream agent can read the question and the answer immediately.
- `prompt` is always present. `final` is `null` when the source reports a terminal
  failure without a terminal assistant message (for example a dsh `error` before any
  assistant output); `status` explains why.
- `prompt` is the message that started the turn. If the user sends further messages while
  the agent is still working, those are intermediate messages and appear only through the
  content endpoint, not in the event.
- `summary` stays for cheap previews and notifications; it is derived from `final.text`
  and is never the authoritative content.
- `promptSeq` / `finalSeq` are message sequence numbers. Everything between them is the
  intermediate process and is not in the event; see [Content access](#content-access).
- `turnId` is the terminal `message.id` for Claude, the native `turn_id` for Codex and
  dsh, and `providerData.conversationRequestId` for WorkBuddy.
- A turn appears in the feed only when it is terminal. In-progress turns are represented
  solely by the session's `session.updated` events.

### Content access

The event deliberately carries only the two endpoint messages. Two read-only endpoints
serve everything else, without bloating the feed or the SSE stream.

#### `GET /api/turn`

```http
GET /api/turn?key=claude:9f3c2a1e-…&turn=7
```

Returns the same `turn` object as the event, plus counts:

```json
{
  "turn": { "sessionKey": "…", "turnSeq": 7, "prompt": { … }, "final": { … }, "…": "…" },
  "messageCount": 7,
  "toolCallCount": 12,
  "toolResultCount": 12
}
```

This is the recovery path when the consumer's cursor predates event retention: after a
`resync`, fetch the turn metadata and the two full messages here instead of replaying the
old event.

#### `GET /api/turn/messages`

```http
GET /api/turn/messages?key=claude:9f3c2a1e-…&turn=7&after=41&limit=200
```

Returns the turn's messages in `seq` order, with full content:

```json
{
  "turn": { "sessionKey": "…", "turnSeq": 7, "promptSeq": 41, "finalSeq": 47 },
  "messages": [
    {
      "seq": 42,
      "role": "assistant",
      "at": 1763999810000,
      "text": "我先看一下日志。",
      "thinking": "……",
      "toolCalls": [{ "id": "toolu_1", "name": "Bash", "input": { "command": "ls" } }],
      "toolResults": [{ "callId": "toolu_1", "output": "a.txt", "isError": false }]
    }
  ],
  "hasMore": true,
  "nextAfter": 58
}
```

- `after` is exclusive. Omit it to fetch the whole turn starting at `promptSeq`; pass
  `after=<promptSeq>` to fetch only the intermediate steps; both modes page the same way.
- `limit` defaults to 200 and is capped at 1000 messages. `maxBytes` (default 2 MB) caps
  the response body: the server returns fewer messages rather than exceed it, and sets
  `hasMore`. A single message larger than the budget is returned alone, never split, and
  tool output is never truncated.
- `nextAfter` is the last returned `seq`; pass it back as `after` until `hasMore` is
  false to read the complete turn.
- Unknown `key` or `turn` is `404` with `{error}`.
- These endpoints have the same trust model as the rest of the API: GET only,
  `127.0.0.1`, `Host` allow-list, no CORS. They expose full transcripts, so they are at
  least as sensitive as the session endpoints.

`GET /api/session?key=…` remains available for consumers that want the whole session in
one response; `/api/turn/messages` is the turn-scoped, paged alternative.

### Storage and emission

```sql
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
  UNIQUE(session_key, turn_seq)
);
CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_key, turn_seq);
```

- Turns are written inside the same transaction as the session, exactly like messages.
  A failing parse or write leaves neither.
- Re-parsing a file rewrites its turns. To avoid re-emitting `turn.completed` for old
  turns on every sync, the transaction selects the existing `(session_key, turn_id)`
  pairs first and appends an event only for newly inserted turns.
- If a turn was inferred and later evidence changes its status (for example an inferred
  `completed` becomes `interrupted`), the hub appends another `turn.completed` with the
  same `turnId`. Consumers dedupe by `sessionKey + turnId` and keep the event with the
  higher `seq`; dedupe by `seq` alone is not enough for corrections.
- Within one sync pass the order is: session event(s), then `turn.completed` for newly
  closed turns, then `sync.completed`.
- Historical data: turns are derived at parse time. Existing rows have none until the
  file changes; a `--rebuild` backfills every session once.
- Event size: a `turn.completed` row contains the full prompt and final answer, so event
  storage grows with conversation text, not just metadata. Retention keeps the existing
  7-day / 50,000-row window and adds a byte budget (for example 256 MB for the events
  table), pruning oldest rows first; the exact numbers are a tuning decision.
- SSE delivery uses the same envelope. A slow client that cannot keep up with large
  `turn.completed` payloads receives `event: resync` rather than blocking the sync loop.

### Consuming it

```sh
cursor=0
while :; do
  body=$(curl -s "http://127.0.0.1:7317/api/events?since=$cursor&type=turn.completed&wait=25")
  cursor=$(printf '%s' "$body" | jq -r .cursor)
  printf '%s' "$body" | jq -c '.events[] | select(.turn.status == "completed")'
done
```

For SSE, listen with `addEventListener('turn.completed', …)`. The event already carries
the prompt and final answer; call `GET /api/turn/messages?key=…&turn=…&after=<promptSeq>`
when the intermediate steps are needed, paging until `hasMore` is false.

### Limits

- WorkBuddy completion is inferred, not reported: the 5s settle window adds latency, and
  a turn that is interrupted without a new prompt stays open until quiescence or a new
  prompt.
- Turn completion is not success. Check `status` before doing work that assumes an
  answer.
- A long tool call produces no completion event until it returns; the feed is a change
  feed, not a progress feed.
- A very large prompt or answer produces a very large event. Long-poll and SSE clients
  must budget memory for it, and the events byte budget may prune older turns earlier
  than the row or day limit suggests.
- If a source rewrites or compacts history, `turnSeq` is recomputed; `turnId` remains
  the stable key.

## Storage

Add one table (schema versioning is `CREATE TABLE IF NOT EXISTS`, matching the current
schema style):

```sql
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  session_key TEXT,
  agent       TEXT,
  at          INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type_seq ON events(type, seq);
```

Writing rules:

- Session events are appended **inside the same SQLite transaction as the session write**.
  `replaceSession()` in `src/db.js` already wraps session + messages + FTS + sync state in
  `transaction()`. Adding the event insert there guarantees "the copy contains the
  session" and "the event exists" never disagree.
- `created` vs `updated` is decided by the existing `hasSession()` check in
  `src/sync.js`; the event append receives that kind.
- Removals are appended from the `pruneMissing()` path, in the same transaction as the
  delete.
- `sync.completed` is appended once per successful sync pass, after removals are known.
- `turn.completed` is appended in the same transaction that inserts a new terminal turn,
  after that session's event. Its payload embeds the full prompt and final message text;
  intermediate messages are not copied into the event.
- Retention: prune events older than 7 days, beyond the newest 50,000 rows, or above a
  byte budget (for example 256 MB of `payload`), whichever trims first, opportunistically
  during sync. A consumer whose cursor predates the window gets `resync: true` and must
  bootstrap again.

`AUTOINCREMENT` is deliberate: without it SQLite may reuse rowids after deletes, which
would break cursor semantics.

## HTTP API

All endpoints are `GET` and inherit the existing server behavior: `127.0.0.1` binding,
`Host` allow-list (`isAllowedHost`), security headers, no CORS headers, no-store caching.
The two content endpoints defined in [Content access](#content-access) — `GET /api/turn`
and `GET /api/turn/messages` — follow the same rules and are not repeated below.

### `GET /api/events`

```http
GET /api/events?since=1287&limit=200&agent=claude,codex&type=session.updated&wait=25
```

Response:

```json
{
  "events": [ /* envelopes, ascending seq */ ],
  "cursor": 1310,
  "hasMore": true,
  "resync": false
}
```

- `since` — exclusive cursor; the response starts at `since + 1`. `0` (or omitted) reads
  the oldest retained event. `now` (or `-1`) means "only future events".
- `limit` — page size, default 200, capped at 1000.
- `maxBytes` — response size cap, default 8 MB. Because `turn.completed` embeds full
  text, the server returns fewer events rather than exceed the budget, sets `hasMore`,
  and returns a single oversized event alone rather than splitting it.
- `agent`, `type` — optional comma-separated filters, applied server-side.
- `wait` — seconds to hold the request open when no events match, default `0`, capped at
  25. When events arrive during the wait, the response returns immediately.
- `hasMore` — true when more matching events are already available past `cursor`.
- `resync` — true when `since` is older than the oldest retained event; the consumer
  should re-run the bootstrap flow. `cursor` is still returned so the consumer can resume
  from the present.

A simple consumer loop:

```sh
cursor=0
while :; do
  body=$(curl -s "http://127.0.0.1:7317/api/events?since=$cursor&wait=25")
  cursor=$(printf '%s' "$body" | jq -r .cursor)
  printf '%s' "$body" | jq -c '.events[]'
done
```

### `GET /api/events/stream`

```http
GET /api/events/stream?since=1287&agent=claude
Accept: text/event-stream
```

```
id: 1288
event: session.updated
data: {"v":1,"seq":1288,"type":"session.updated", …}

: heartbeat
```

- `id:` is the event `seq`, so a reconnecting client resumes automatically via
  `Last-Event-ID`.
- `event:` is the event `type`, allowing `addEventListener('session.updated', …)`.
- A comment heartbeat is sent every 15 seconds to keep intermediaries and clients from
  timing out.
- Per-connection queue is bounded by count (default 1000) and bytes (for example 32 MB,
  since `turn.completed` can be large). On overflow the server sends `event: resync` with
  the latest cursor and closes the connection; it never blocks the sync loop.

### Upstream additions for bootstrap

`GET /api/status` gains a `lastEventSeq` field (additive, backward compatible). The
bootstrap sequence avoids replaying the initial full-sync storm:

1. `GET /api/sessions` — take a snapshot (and its `lastEventSeq`, returned alongside the
   list).
2. Remember that `lastEventSeq`.
3. `GET /api/events?since=<lastEventSeq>` (or `/api/events/stream?since=…`).

A consumer that does not care about existing sessions can subscribe with
`since=now` and skip the snapshot.

## Delivery semantics

- **At least once.** Consumers deduplicate by `seq`. There is no ack, lease, or server-side
  consumer registry; the cursor belongs to the consumer. `turn.completed` corrections
  reuse the same `turnId` with a higher `seq`, so consumers that act on turns should also
  key by `sessionKey + turnId` (see [Storage and emission](#storage-and-emission)).
- **Ordering.** `seq` ordering is total and stable. Within one sync pass: session events,
  then `turn.completed` for newly closed turns, then the closing `sync.completed`.
- **Restarts.** The journal is in the same SQLite database as the copy, so a hub restart
  does not lose events. The first sync after a restart appends normal `updated` events
  for files whose mtime/size changed while the hub was down.
- **Missed window.** If the consumer was offline longer than the retention window, it
  receives `resync: true` and must bootstrap. Events are never silently skipped.
  Pruned `turn.completed` events can be reconstructed with `GET /api/turn`, which keeps
  the same turn metadata and the two full messages.
- **Backpressure.** HTTP responses page via `limit`/`hasMore`; SSE drops to `resync` for
  slow clients.
- **Idempotency hint.** Consumers that trigger expensive work per event should key on
  `session.id` plus `updatedAt`, or on `sessionKey + turnId` plus `finalSeq` for turns,
  so a re-delivered event after a reconnect does not repeat side effects.

## Filtering and batching

- Server-side filters (`agent`, `type`, later `cwd`) keep responses focused; consumers
  should not receive events they always discard. Note that `turn.completed` is
  intentionally large: a consumer that only needs metadata should filter it out and
  subscribe to the session events alone.
- One sync pass produces at most one session event per session, because each source file
  is parsed once per pass, and at most one `turn.completed` per newly closed turn.
- No time-based debouncing: it would introduce windows where events can be lost. Consumers
  that want coarse-grained reactions subscribe to `sync.completed` instead.
- A consumer that wants "what changed in the last hour" can page `since` without `wait`
  and stop when it reaches the present.

## Security and privacy

- Read-only endpoints on `127.0.0.1`, no authentication, same trust model as the rest of
  the API. No new privileged operation is introduced.
- No outbound requests are added, preserving the "no external network calls" promise in
  the README. Not building webhooks is what keeps that promise intact.
- No CORS headers are added, so a web page cannot read the event stream cross-origin.
- Event titles, summaries, and the full `prompt.text` / `final.text` in `turn.completed`
  are session content. Document them as equally private, and keep any persisted queue or
  metadata directory at `0700` / `0600` as with logs. The events table now persists
  conversation text, so it carries the same protections as the session copy.
- Intermediate reasoning, tool arguments, and tool output are never written to the events
  table; they stay in the message/tool tables and are read through
  `/api/turn/messages`, under the same loopback-only, no-CORS, no-store rules.

## Where it plugs into the code

| File | Change |
| --- | --- |
| `src/schema.sql` | `events` table and index; `turns` table and index |
| `src/sources/claude.js`, `codex.js`, `dsh.js`, `workbuddy.js` | Return turn boundaries alongside messages, including the full prompt text and terminal assistant text: grouped `stop_reason`, paired Codex `task_started`/`task_complete`, dsh `turn/start`/`turn/end`, and the WorkBuddy inference rule |
| `src/db.js` | `appendEvent()` (called inside the existing `transaction()` in `replaceSession`), `eventsSince()`, `pruneEvents()`; persist derived turns inside the same transaction, embed untruncated prompt/final text in `turn.completed`, and emit only newly inserted turns; turn-content queries with paging; removal events from `pruneMissing()` |
| `src/sync.js` | Extend change records with `key`, `project`, `updatedAt`, `lastMessageSeq`; pass parsed turns through; close turns left open by a new prompt or EOF; append `sync.completed` at the end of `syncOnce()` |
| `src/server.js` | `/api/events` and `/api/events/stream` handlers, `/api/turn` and `/api/turn/messages` (paging, `maxBytes`), `lastEventSeq` in `/api/status` and `/api/sessions` responses, SSE heartbeat/queue helper |
| `src/hub.js` | Expose the current event head (or read `max(seq)` when serializing status) |
| `src/events.js` (new) | Event envelope construction/serialization and cursor helpers, so the wire format is unit-testable without HTTP |
| `README.md`, `README.zh.md` | Document the endpoints, cursor semantics, the two-message content policy, retention, and privacy note |

The server currently enforces `GET`-only before routing and already validates the `Host`
header, so the new routes need no extra method checks beyond the existing guard.

## Testing plan

TDD, per the project convention:

- Event append is transactional: a failing session write leaves no event; a successful one
  leaves exactly one.
- `created` vs `updated` mapping, and `removed` events from pruning.
- `since`/`limit` paging, `hasMore`, filter combinations, invalid cursor handling.
- `resync` when the cursor predates retention, including `since=now`.
- `sync.completed` ordering and counts.
- SSE framing (id/event/data), heartbeat emission, slow-client `resync` and disconnect.
- Reconnect using `Last-Event-ID` resumes exactly after the last delivered `seq`.
- Bootstrap: snapshot + `lastEventSeq` produces no duplicates and no gaps under a
  concurrent sync.
- Restart: events survive, cursor continues monotonically.
- Retention pruning does not break `seq` monotonicity.
- Turn boundaries per source: Claude `end_turn` vs `tool_use` and split `message.id`
  lines; Codex `task_started`/`task_complete` pairing; all four dsh `reason.kind` values;
  WorkBuddy completion, `Interrupted by user`, unresolved `function_call`, and compaction
  user messages that must not start a turn.
- WorkBuddy inference does not close a turn when a text message and its same-`messageId`
  `function_call` are written 1ms apart and the sync lands between them.
- Re-parsing an unchanged file appends no second `turn.completed`; a status correction
  appends a higher `seq` with the same `turnId`.
- A new human prompt after a turn left open by a killed process closes it as
  `interrupted` before the new turn's events.
- `turn.completed` carries the exact full prompt and final text: a multi-kilobyte prompt
  and a 100 KB answer round-trip unchanged, and the payload contains no intermediate
  assistant text, tool arguments, or tool output.
- `final` is `null` for a terminal failure with no assistant message.
- `GET /api/turn` returns the same `turn` object as the event plus counts;
  `GET /api/turn/messages` pages correctly with `after`/`limit`, respects `maxBytes`, never
  splits an oversized single message, truncates no content, and returns 404 for unknown
  `key` or `turn`.
- After a `resync`, fetching the turn through `/api/turn` reconstructs the same prompt and
  final text as the pruned event.
- The events byte budget prunes oldest rows without breaking `seq` monotonicity.

## Phases

- **P1** — event table, cursor API, SSE stream, `lastEventSeq` bootstrap, filters,
  retention, turn detection and `turn.completed` events for all four sources (with full
  prompt/final text), plus `/api/turn` and `/api/turn/messages`.
- **P2** — `session-hub mcp` (stdio) exposing `list_sessions`, `get_session`, and
  `wait_for_changes` as tools on top of the same cursor model.
- **P3** — optional `~/.session-hub/events.jsonl` append-only outbox for `tail -f`-style
  consumers, or loopback-only webhooks if a concrete need appears.

## Risks and open questions

- **Event volume and size.** An initial full sync on a large corpus appends thousands of
  `created` events. Bootstrap with `lastEventSeq` and `since=now` avoid replaying them.
  `turn.completed` now stores full prompt and answer text, so retention must budget bytes
  as well as rows; measure real event sizes before fixing the numbers.
- **Summary preview.** The 80-character summary is only a notification preview; the
  authoritative content is `final.text`. Consumers that need a short form should truncate
  locally rather than expect the event to omit the answer.
- **Consumer model.** If downstream agents need "claimed/done" work semantics, that is a
  queue on top of the feed (subscriber ids, leases), not a change to this design.
- **MCP priority.** If the primary consumer is another agent rather than a script, P2 may
  need to move ahead of P1 polish.
- **Retention window.** 7 days / 50,000 events is a starting point; revisit once real
  event rates are measured.
- **WorkBuddy inference.** WorkBuddy has no native completion marker, so its
  `turn.completed` events are inferred from append order plus a settle window. A future
  WorkBuddy version may add an explicit record; revisit then and switch those events to
  `signal: "native"`. Until then, consumers must be able to live with an inferred signal.
