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
- Keep the event stream small: metadata plus a one-line summary, never full transcripts.
  Consumers fetch content through the existing session endpoints when they need it.
- Support both modes downstream agents actually use: a long-lived stream (SSE) and a
  simple blocking poll that any HTTP client or shell script can drive.
- Avoid an event storm during the initial full sync, while still making bootstrap
  correct and race-free.

## Non-goals

- Webhooks or any consumer-registered callback URL. Consumers are local; callbacks would
  add registration, retries, authentication, and SSRF surface for no benefit.
- Delivery of message-level events. The unit of change is a session, matching how sync
  already works.
- Consumer-side processing state ("pending"/"done"/acknowledged work queues). This is a
  change feed, not a task queue.
- Multi-hub aggregation. The pid file already enforces one hub per database directory.
- Cross-machine or public exposure.

## Why this shape

| Option | Survives restarts | Consumer cost | Risks | Decision |
| --- | --- | --- | --- | --- |
| Durable event table + `since` cursor over HTTP | Yes | One GET | None | **Primary transport** |
| SSE endpoint on the same cursor | Yes (`Last-Event-ID`) | `fetch` stream | Slow-client backpressure | **Live transport** |
| Webhook callbacks | Needs retry machinery | Consumer must serve HTTP | SSRF, auth, offline failures | Not built |
| Filesystem outbox (`events.jsonl` + `tail -f`) | Yes | Read a file | Rotation/truncation semantics | Optional P3 |
| MCP server | Via the same cursor | Native tool calls | Larger implementation | P2 |

The event table is the source of truth. Both transports read from it, so they share one
cursor model and one payload schema. A consumer that misses a stream window can resume
with the last `seq` it saw, regardless of which transport delivered it.

## Event model

Every event has a small, versioned envelope:

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
- `session.summary` — the same one-line summary the CLI log already prints
  (`latestSummary()` in `src/sync.js`, limited to 80 characters via `oneLine`).
- `session.lastMessageSeq` — the sequence number of the newest message in the copy, so a
  consumer can fetch just the new messages instead of the whole session.
- `project` — derived from the session cwd (or the existing virtual grouping). Included
  because downstream coordination is usually project-scoped.
- `v` — payload version. Adding optional fields does not bump it; changing field meaning
  does.

Events contain no message bodies and no tool output. A consumer that needs content calls
`GET /api/session?key=…` or the existing list endpoint.

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
- Retention: prune events older than 7 days or beyond the newest 50,000 rows (whichever
  trims first), opportunistically during sync. A consumer whose cursor predates the
  window gets `resync: true` and must bootstrap again.

`AUTOINCREMENT` is deliberate: without it SQLite may reuse rowids after deletes, which
would break cursor semantics.

## HTTP API

All endpoints are `GET` and inherit the existing server behavior: `127.0.0.1` binding,
`Host` allow-list (`isAllowedHost`), security headers, no CORS headers, no-store caching.

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
- Per-connection queue is bounded (default 1000). On overflow the server sends
  `event: resync` with the latest cursor and closes the connection; it never blocks the
  sync loop.

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
  consumer registry; the cursor belongs to the consumer.
- **Ordering.** `seq` ordering is total and stable. Within one sync pass, session events
  precede the closing `sync.completed`.
- **Restarts.** The journal is in the same SQLite database as the copy, so a hub restart
  does not lose events. The first sync after a restart appends normal `updated` events
  for files whose mtime/size changed while the hub was down.
- **Missed window.** If the consumer was offline longer than the retention window, it
  receives `resync: true` and must bootstrap. Events are never silently skipped.
- **Backpressure.** HTTP responses page via `limit`/`hasMore`; SSE drops to `resync` for
  slow clients.
- **Idempotency hint.** Consumers that trigger expensive work per event should key on
  `session.id` plus `updatedAt` (or fetch the session and compare `messageCount`) so a
  re-delivered event after a reconnect does not repeat side effects.

## Filtering and batching

- Server-side filters (`agent`, `type`, later `cwd`) keep payloads small; consumers should
  not receive events they always discard.
- One sync pass produces at most one session event per session, because each source file
  is parsed once per pass.
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
- Event titles and summaries are session content. Document them as equally private, and
  keep any persisted queue/metadata directory at `0700` / `0600` as with logs.
- Events deliberately omit message bodies, tool output, and file contents.

## Where it plugs into the code

| File | Change |
| --- | --- |
| `src/schema.sql` | `events` table and index |
| `src/db.js` | `appendEvent()` (called inside the existing `transaction()` in `replaceSession`), `eventsSince()`, `pruneEvents()`; removal events from `pruneMissing()` |
| `src/sync.js` | Extend change records with `key`, `project`, `updatedAt`, `lastMessageSeq`; append `sync.completed` at the end of `syncOnce()` |
| `src/server.js` | `/api/events` and `/api/events/stream` handlers, `lastEventSeq` in `/api/status` and `/api/sessions` responses, SSE heartbeat/queue helper |
| `src/hub.js` | Expose the current event head (or read `max(seq)` when serializing status) |
| `src/events.js` (new) | Event envelope construction/serialization and cursor helpers, so the wire format is unit-testable without HTTP |
| `README.md`, `README.zh.md` | Document the endpoints, cursor semantics, retention, and privacy note |

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

## Phases

- **P1** — event table, cursor API, SSE stream, `lastEventSeq` bootstrap, filters, retention.
- **P2** — `session-hub mcp` (stdio) exposing `list_sessions`, `get_session`, and
  `wait_for_changes` as tools on top of the same cursor model.
- **P3** — optional `~/.session-hub/events.jsonl` append-only outbox for `tail -f`-style
  consumers, or loopback-only webhooks if a concrete need appears.

## Risks and open questions

- **Event volume.** An initial full sync on a large corpus appends thousands of `created`
  events. Bootstrap with `lastEventSeq` and `since=now` avoid replaying them; retention
  caps storage. Confirm the expected daily volume before fixing the retention numbers.
- **Summary quality.** The 80-character one-line summary may be too thin for autonomous
  coordination. Options: add an opt-in `?include=lastMessage` excerpt, or let consumers
  fetch the session. Decide based on the first real downstream.
- **Consumer model.** If downstream agents need "claimed/done" work semantics, that is a
  queue on top of the feed (subscriber ids, leases), not a change to this design.
- **MCP priority.** If the primary consumer is another agent rather than a script, P2 may
  need to move ahead of P1 polish.
- **Retention window.** 7 days / 50,000 events is a starting point; revisit once real
  event rates are measured.
