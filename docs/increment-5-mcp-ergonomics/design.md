# Increment 5 — MCP ergonomics: fewer rounds, steered agents

## What & why

The read-latency investigation (`docs/investigations/2026-07-15-read-latency.md`) proved the
dominant cost of using trunkline is the **visiting agent's think-act cycle (~4–10s per tool
call)**, not the server (<5ms) — the naive 9-verb scenario took 86.5s against 5.9s batched.
Increment 3 attacked the CLI path; this increment attacks the MCP path the same way: make
one call do a task's worth of work, and put the operating knowledge where a *visiting MCP
agent actually sees it* (today the "keep it fast" rules live only in the README, which an
MCP-only agent never reads).

## Goals

- **G1 — server `instructions`.** The MCP initialize response carries a concise operating
  manual (the ring pattern, listen-WAITS-vs-inbox-reads, reply+ack in one `send`, batch
  economics). Claude-family harnesses surface instructions to the model.
- **G2 — `send.to`: reply by peer name in one round.** MCP `send` currently requires
  `threadId`, forcing a `threads` lookup round on any agent that only knows its peer's name.
  `SendInput` gains `to` as an alternative to `threadId` (exactly one — enforced by a core
  guard in `service.send`, the single point all surfaces share): resolve to the open
  (TTL-effective) thread with that peer; multiple open threads → `AMBIGUOUS_THREAD` (409)
  listing ids, preserving the CLI's existing guard; none open → the most recently ended one
  (reopen-on-send); no history → `NOT_FOUND` steering to `call`; self-send rejected like
  `call`. Core-level, so every surface gets it; the CLI's client-side `resolvePeerThread`
  (two HTTP rounds) is replaced by the server-side resolution (one round).
- **G3 — `listen` tool gains `ack: boolean` (default false).** Read+ack in one round for
  agents accepting the same durability trade-off as CLI `listen --ack`. `inbox` stays a pure
  peek — a cursor-advancing option would contradict its `readOnlyHint` (G6).
- **G4 — `snapshot` tool.** Phonebook + open threads + unacked inbox in one call — the
  "what's my state" opener that today costs three rounds.
- **G5 — result hints.** `listen`/`inbox` tool results append a `hint` field with the exact
  one-round follow-up (e.g. `reply+ack: send {to, body, ackThrough: <cursor>}`); tool
  descriptions tightened to match.
- **G6 — annotations + compact output.** `readOnlyHint: true` on
  phonebook/inbox/history/threads/snapshot (permission-prompt reduction in harnesses that
  honor it), `idempotentHint` on ack; all MCP results serialize compact (no 2-space
  pretty-print — smaller results stream into the visiting agent's context faster and
  cheaper).

## Non-goals

- No push transport, no protocol/session changes. Existing HTTP routes stay untouched; the
  `to` form gets ONE additive route (`POST /api/messages`, the unified send entry parsing
  the full threadId-XOR-to input) because the existing send route is path-addressed by
  threadId and cannot carry a peer-name form.
- No CLI UX changes beyond `sendTo` internally delegating to the new core resolution
  (same flags, same output).
- No README overhaul (rules already there; only the MCP-side duplication is new).

## Architecture touchpoints

- `src/core/contracts.ts` — `SendInputSchema`: `threadId` OR `to` (zod refine: exactly one).
- `src/core/service.ts` — `send` resolves `to` → thread via one store query path (open
  first, then latest ended, reusing `listThreadsFor` ordering or a dedicated store lookup if
  the ordering contract is insufficient); event gains nothing new (`threadId` stamped as
  today after resolution).
- `src/client/client.ts` + `src/cli/commands.ts` — `sendTo` becomes a thin `send({ to, … })`
  (client-side two-round resolution deleted; its behavior contract — "reopens the latest
  ended thread with the peer" — moves to core tests).
- `src/mcp/tools.ts` — instructions option on `McpServer`; `snapshot` tool (composes three
  existing service calls; three canonical events, one per operation, consistent with the
  observability convention); `ack` option on listen/inbox handlers (delegates to
  `service.ack` after delivery, mirroring CLI `--ack`); annotations; compact `text()`;
  result hints.
- Dependency DAG unchanged: mcp stays a thin adapter over PhoneService.

## Acceptance criteria

- AC1: MCP initialize response carries the instructions text (asserted via a stateless
  `handleMcpRequest` round-trip in tests).
- AC2: `send {to}` works on all three surfaces: open-thread case (other peers excluded),
  ambiguous-open case (`AMBIGUOUS_THREAD`), reopen-ended case, no-thread `NOT_FOUND`-with-
  steering case, self-send rejection; `send {threadId}` unchanged; passing both/neither →
  `VALIDATION_ERROR` from the core guard on every surface. CLI `send --to` behavior
  preserved (contract moved to core tests; sendTo tests rewritten to pin forwarding), now
  via one HTTP round.
- AC3: `listen {ack:true}` delivers and advances the cursor in one tool call; default false
  preserves current semantics; `inbox` remains peek-only.
- AC4: `snapshot` returns `{ agents, threads, messages, cursor }` shapes consistent with the
  individual verbs.
- AC5: read-only annotations present on the five read tools; all MCP results compact.
- AC6: suite green; measured MCP round count for the canonical exchange (ring pops → read →
  reply+ack) is 1 tool call (was 3–4), evidenced in impl.md via a headless `claude -p`
  scenario re-run.

## Test strategy

Behavior-level, minimum-optimal: core tests for `to` resolution (three cases + XOR
validation) — these REPLACE the CLI-level `resolvePeerThread` tests whose contract moves
inward (the CLI keeps one thin forwarding test); one MCP integration test through
`handleMcpRequest` for instructions + snapshot + ack-on-listen (real JSON-RPC round-trip,
in-memory store); no tests for annotation metadata beyond presence (harness behavior is
dependency-owned); no timing tests (AC6 is measurement evidence).
