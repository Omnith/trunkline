# Increment 1 — agentphone core (design)

Date: 2026-07-14. Status: approved by user after brainstorming.
Context: see `docs/overview.md` for product vision, architecture principles, and deployment reality.

## What & why

A single TypeScript service ("agentphone") that lets Claude Code agents on different machines
register into a phonebook, open calls (threads), exchange messages, and leave voicemail — replacing
hand-typed human relaying between the `gha-docker-runner` agent (Windows) and the `volumi` agent
(MacBook). One core, three thin surfaces: JSON HTTP API, MCP streamable-HTTP tools, and a typed CLI.

## Decisions log (from brainstorming)

| Question | Decision |
|---|---|
| Hosting | Server on one mesh machine (Windows box, `100.110.150.142:4747`); later Fly-behind-Cloudflare with the same client methodology |
| Surface | HTTP API + CLI **and** MCP, both day one, as thin adapters over one core |
| Language | TypeScript (strict), Node 20+ |
| Semantics | Threads + presence; no ringing/answer state machine |
| Auth | Per-agent bearer tokens; auth = identity |
| Persistence | SQLite via better-sqlite3, WAL mode |
| Self-registration | Yes, via admin-minted single-use invite codes; no open registration |
| Call-state TTL | Thread openness lapses after 24h idle (lazy, derived at read time); messages/cursors never expire |
| Delivery | At-least-once: explicit ack advances a per-agent cursor; listen/inbox never silently consume |
| Ended threads | Sending to an ended thread reopens it (status is advisory, never a gate) |

## Architecture

```
                 ┌──────────── agentphone server (one Node process) ───────────┐
CLI (Bash) ──HTTP JSON──►  http adapter ─┐                                     │
MCP clients ─streamable──► mcp adapter ──┼──► PhoneService (core) ──► store    │
                HTTP       (same port)   │        │        │          (SQLite) │
                                         │     emitter   clock                 │
                                         │     (jsonl)   (injected)            │
                 └─────────────────────────────────────────────────────────────┘
```

- `src/core/` — zod contracts (input/output schema per verb) + `PhoneService`. Ports: `Store`,
  `Emitter`, `Clock`. No I/O, no framework imports.
- `src/store/` — better-sqlite3 `Store` adapter.
- `src/http/` — express routes; auth middleware maps bearer token → agent identity once at the
  boundary; core trusts identities. Validation (zod) at this boundary only.
- `src/mcp/` — MCP tools via `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport`, mounted
  on the same express app at `/mcp`. Tool schemas are the core zod schemas.
- `src/client/` — typed fetch client for the HTTP API (shared by CLI).
- `src/cli/` — commander commands, including `serve` (starts server) and `admin` (server-host only,
  direct DB access, no HTTP surface).

Express is chosen because the MCP SDK's streamable transport is documented against it.

## Domain model

**Agent** — `name` (unique lowercase slug handle), hashed token, optional free-text `status`,
`lastSeenAt`. Every authenticated request bumps `lastSeenAt`. Provisioning is operator-gated
(admin command or invite redemption); agents cannot mint identities.

**Thread ("call")** — `id`, `subject`, two participants, `open | ended` (+ `endedBy`, `endNote`),
`lastActivityAt`. `call` opens one; `hangup` closes with optional note. Sending to an ended thread
**reopens** it. **Effective status is derived at read time**: `ended` if explicitly hung up or no
activity within the TTL window (default 24h, configurable). No sweeper process.

**Message** — global monotonic `id` (AUTOINCREMENT), `threadId`, `sender`, `recipient`, text `body`
(≤ 64KB), `kind: message | system`, `createdAt`. No attachments.

**Cursor** — one per agent, global across threads: `ackedThroughMessageId`. Voicemail is not an
entity: it is simply messages addressed to you with `id >` your cursor.

**Invite** — `codeHash` (single-use), optional `pinnedName`, `expiresAt` (24h default), `usedBy/At`.

### State lifetime

| State | Persisted | Expires |
|---|---|---|
| Agents, tokens | yes | never (admin revoke/rotate) |
| Messages, cursors | yes | never |
| Thread open/ended | yes | openness lapses after 24h idle (lazy, derived) |
| Invites | yes | 24h or first use |
| `listening` flag | no (in-memory) | when the long-poll closes |

## Operations contract (core port — 11 verbs)

Each verb is a zod input/output schema pair; all surfaces adapt these.

| Verb | Does | Notes |
|---|---|---|
| `register` | Redeem invite → mint token | Unauthenticated; single-use, expiry, pinned-name enforcement |
| `checkin` | Update my status text | Presence also bumps implicitly on every call |
| `phonebook` | List agents + presence | `lastSeenAt`, `listening` (live long-poll open), status |
| `call` | Open a thread | `to`, `subject`, optional first `body` |
| `send` | Message into a thread | Strict `threadId` at core; reopens ended threads |
| `listen` | Long-poll for unacked messages | Returns immediately if any exist, else parks ≤ `waitMs` |
| `ack` | Advance cursor through message id | The at-least-once commit point; idempotent |
| `inbox` | Peek unacked; no wait, no ack | "Check voicemail" (= `listen` with `waitMs=0`) |
| `history` | Read a thread's messages | Paginated (`afterId`, `limit`) |
| `threads` | List my threads | Filter `open | ended | all` (effective status) |
| `hangup` | End a thread | Optional closing note (recorded as system message) |

## Surfaces

### HTTP API

```
GET   /api/health                                 unauthenticated liveness
POST  /api/register              {name, inviteCode}   → token (returned once)
GET   /api/agents                                 phonebook
PATCH /api/agents/me             {status?}        checkin
POST  /api/calls                 {to, subject, body?} call
GET   /api/calls?status=open|ended|all            threads
POST  /api/calls/:id/messages    {body}           send
GET   /api/calls/:id/messages?afterId=&limit=     history
POST  /api/calls/:id/hangup      {note?}          hangup
GET   /api/inbox?waitMs=0..60000                  inbox (waitMs=0) / listen (waitMs>0)
PUT   /api/cursor                {throughMessageId}   ack
```

Auth: `Authorization: Bearer ap_<random>`; the server stores only the SHA-256 hash and verifies
tokens by indexed hash lookup (the raw token is never compared directly).
Errors: single shape `{ error: { code, message, details? } }` with conventional statuses
(401 bad token, 404 unknown thread or recipient, 409 name already taken, 410 invite expired
or used, 413 payload too large, 422 validation). Boundary rejections (validation, oversized
bodies) emit a canonical event too, so every verb request yields exactly one event (liveness
pings to /api/health and unmatched-route 404s are not operations and emit none).

### MCP

Mounted at `/mcp` on the same port (streamable HTTP, stateless), same bearer header
(`claude mcp add agentphone --transport http <url>/mcp --header "Authorization: Bearer …"`).
Tools mirror the authenticated verbs 1:1 (no `register` tool). The `listen` tool defaults
`waitMs` to 25s to stay inside MCP client timeouts; the core-wide `waitMs` maximum is 60s on
every surface. The tool description points agents at the CLI for background listening.

### CLI

Config: `AGENTPHONE_URL` + `AGENTPHONE_TOKEN` env vars (fail fast, clear message if missing).
Bodies via `-m` or stdin (pipe diffs/logs without quoting hell).

```
agentphone register --name lab7 --invite ap-invite-XXXX   # redeem invite, print token once
agentphone checkin [--status "..."]
agentphone phonebook
agentphone call <agent> --subject "..." [-m "..."]
agentphone send --thread <id> -m "..."
agentphone send --to <agent> -m "..."    # sugar: resolves your single open thread with that
                                         # peer; errors listing candidates if ambiguous
agentphone listen [--wait 3600] [--ack]  # THE RING: loops ≤60s long-polls internally,
                                         # exits when messages arrive (background this)
agentphone inbox
agentphone ack --through <id> | --all
agentphone history <threadId> [--after <id>]
agentphone threads [--open|--all]
agentphone hangup <threadId> [--note "..."]
agentphone serve                          # server host
agentphone admin add|invite|list|revoke   # server host only, direct DB, no HTTP surface
```

`listen` exit-on-delivery is the notification mechanism: an agent backgrounds it via Bash;
process exit re-invokes the agent with the printed messages. `--ack` (auto-ack on delivery)
is opt-in sugar for casual checks; default is explicit ack.

## Delivery semantics

- **At-least-once.** Messages are re-delivered on every `listen`/`inbox` until acked. Duplicates
  carry stable ids; agents ack through the highest id they have processed.
- **Long-poll implementation:** check-then-park. Query unacked; if empty, register an in-process
  waiter keyed by recipient; message insert wakes waiters, which re-query. better-sqlite3 is
  synchronous, so there is no missed-wakeup window between check and park.
- **Ordering:** global message-id order (single writer, AUTOINCREMENT). Global monotonicity of
  message ids across restarts is a deliberate contract the cursor model relies on; restoring the
  DB from a backup would violate it (out of scope this increment).
- **Batch cap:** a single `listen`/`inbox` delivers at most 500 messages (named constant, stated
  contract); remaining messages arrive on the next poll.
- **No per-thread filtering on `listen`/`inbox`:** a thread-filtered listen cannot safely drive
  the single global cursor (acking a filtered slice would skip unseen messages in other threads).
  `history` is the per-thread read.

## Persistence (SQLite, WAL)

```sql
agents   (name PK, tokenHash UNIQUE, status, lastSeenAt, createdAt)
invites  (id PK, codeHash UNIQUE, pinnedName?, expiresAt, usedBy?, usedAt?, createdAt)
threads  (id PK AUTOINCREMENT, subject, participantA, participantB, openedBy,
          status open|ended, endedBy?, endNote?, openedAt, endedAt?, lastActivityAt)
messages (id PK AUTOINCREMENT, threadId FK, sender, recipient, body, kind, createdAt)
cursors  (agent PK, ackedThroughMessageId)
```

Indexes: `messages(recipient, id)`, `messages(threadId, id)`, `threads(participantA)`,
`threads(participantB)`.

## Observability & config

- One canonical wide event per operation via injected `Emitter` port → jsonl sink:
  `{ts, op, surface: http|mcp, agent, outcome, errorCode?, durationMs, waitedMs?, threadId?,
  messageId?, deliveredCount?}`. In-memory sink for test assertions. No ad-hoc logging on core
  paths.
- Injected `Clock` port (`now()`) — lazy TTL derivation needs controllable time in tests.
- Server config (effective defaults): port `4747`, db `./agentphone.db`, bind `127.0.0.1`
  (set `AGENTPHONE_BIND=0.0.0.0` to expose on the mesh), thread openness TTL
  `AGENTPHONE_THREAD_TTL_HOURS=24`. Client config (fail-fast, required): `AGENTPHONE_URL`,
  `AGENTPHONE_TOKEN`.
- Tooling: eslint (typescript-eslint strict flat config) + prettier; vitest; tsup for the
  build; strict `tsconfig`.

## Testing strategy (minimum-optimal, contract-focused)

Unit — `PhoneService` against `:memory:` SQLite, one test per owned contract:
invite lifecycle (redeem / single-use / expiry / pinned name), reopen-on-send, listen wake +
at-least-once redelivery until ack, inbox-doesn't-consume, lazy TTL derivation, token→identity
mapping, `send --to` resolution logic (pure function).

Integration — boot real server on ephemeral port; full story: register via invite → call →
park a listen → send from other agent → listen resolves → ack → **restart server, state
survives** → 401 on bad token. Plus one MCP SDK client round-trip (list tools, call one).

No UI; no Playwright.

## Deployment

- `agentphone serve` on the Windows box, bound to the mesh; MacBook sets
  `AGENTPHONE_URL=http://100.110.150.142:4747`.
- Repo cloned on both machines day one (`npm i && npm run build`, or tsx).
- Later: same process on Fly.io behind Cloudflare (TLS upstream); tokens unchanged.

## Non-goals (this increment)

- No open self-registration, no admin HTTP surface, no attachments, no message TTL/retention
  policies, no WebSockets/SSE push, no multi-party (>2) threads, no TLS termination in-process,
  no broadcast (every message has exactly one recipient).

## Acceptance criteria

1. Two agents on different machines can, unattended: register via invite, see each other in the
   phonebook, open a call, exchange messages via backgrounded `listen` (exit-on-delivery ring),
   leave/retrieve voicemail while the peer is away, and hang up.
2. Unacked messages survive server restart and are re-delivered on next `listen`/`inbox`.
3. A wrong or missing token is rejected (401) on every authenticated route; an invite is
   single-use and expires.
4. MCP client (`claude mcp add`) can list the tools and run `phonebook`, `send`, `listen`
   round-trips against the same server.
5. Every operation emits exactly one canonical wide jsonl event.
6. Build, tests, and lint pass on Node 20+ on both Windows and macOS.
