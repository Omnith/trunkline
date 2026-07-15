# Increment 3 — read-latency optimizations

## What & why

The diagnosis in `docs/investigations/2026-07-15-read-latency.md` established that agentphone's
server, network, and protocol layers are all sub-5ms; the perceived 30s+ "read latency" is
**agent-loop wall-clock** (each agent tool call costs a 4–15s think-act cycle) amplified by one
genuine client defect (**every CLI verb costs ~610ms** because `src/cli/index.ts` imports the
whole server stack at module scope) and one operational defect (**no graceful shutdown** —
`docker stop` burns the 10s grace period, then SIGKILLs, observed exit 137).

This increment removes the measurable waste we own and steers agents toward fewer, batched
calls — the only lever that attacks the dominant cost.

## Goals

- **G1 — fast CLI**: client verbs stop loading express/MCP-SDK/better-sqlite3. Target: `time
  node dist/agentphone.js inbox` p50 ≤ 250ms on the dev box (from ~610ms).
- **G2 — graceful shutdown**: `serve` handles SIGTERM/SIGINT; parked long-polls resolve empty
  immediately; store and HTTP server close cleanly; `docker stop` returns fast with exit 0.
- **G3 — reply+ack in one round**: optional `ackThrough` on `send`, so the most common agent
  exchange (ack what you read + reply) is one call instead of two. Surfaces inherit it (MCP
  via schema-shape reuse, CLI via `--ack-through`).
- **G4 — steering**: README agent guidance and MCP tool descriptions teach the cheap patterns:
  the ring output already contains the messages; batch verbs in one shell call; never
  foreground-listen inside a turn; never pipe `listen` (exit code is the signal); `listen`
  waits — `inbox` reads instantly.

## Non-goals

- No new transport/push mechanism; no protocol overhaul; no new surfaces.
- No Mac-specific work (H3 pending volumi-side measurements; G1 helps it regardless).
- No fix for the deferred waiter-release-on-client-disconnect debt (tracked in increment-1
  impl notes) beyond what shutdown release requires.

## Architecture touchpoints

- `src/cli/index.ts` — the only file allowed to know both worlds; `serve` and `admin` actions
  move to `await import(...)` so the client path never evaluates `http/server.js` or
  `store/sqlite.js`. `tsup.config.ts` gains `splitting: true` (esm chunking) so the bundled
  server subtree lands in a lazily-loaded chunk.
- `src/core/waiters.ts` — `releaseAll()` wakes every parked waiter and flips a `draining`
  flag; the listen loop's exit condition consults it (a bare wake would just re-park — the
  loop re-checks "messages or window elapsed" and neither holds during shutdown).
- `src/core/service.ts` — exposes waiter release for shutdown (thin delegation; Waiters stays
  internal). `send` gains optional cursor-advance before insert, sharing the ack semantics
  (idempotent, capped at max message id) via one private helper used by both `ack` and `send`.
- `src/core/contracts.ts` — `SendInputSchema` + `ackThrough` optional positive int.
- `src/http/server.ts` — `close()` releases waiters first, then closes HTTP + store; `serve`
  action wires `process.once('SIGTERM'|'SIGINT')` → close → exit 0.
- `src/mcp/tools.ts` — `send` picks up `ackThrough` via `.shape` reuse automatically;
  description updates for `listen`/`send`.
- `README.md` — agent-section playbook for low-latency usage.

Dependency DAG unchanged: core knows nothing new about surfaces; cli composes lazily.

## Observability

`close()` emits one canonical `shutdown` event (op added to the event type) with outcome and
durationMs, so container stop/restarts are visible in the same jsonl stream. `send` events
carry `ackedThrough` when the piggyback is used.

## Acceptance criteria

- AC1: `node dist/agentphone.js inbox` p50 ≤ 250ms locally (evidence in impl.md; no timing
  assertions in the test suite — flaky).
- AC2: with a parked listen in flight, `close()` resolves promptly (parked request completes
  empty first); `docker stop agentphone` exits within ~2s, exit code 0.
- AC3: `send` with `ackThrough` advances the sender's cursor (idempotent, capped) and sends,
  in one operation, on both HTTP and MCP surfaces; CLI `send --ack-through <id>` works.
- AC4: README + MCP descriptions carry the four steering rules (G4).
- AC5: entire existing suite stays green — behavior contracts unchanged for existing verbs.

## Test strategy

Behavior-level, minimum-optimal (per repo methodology):

- `Waiters.releaseAll` — parked `wait()` resolves; no-op when nothing parked.
- Shutdown — integration test against `startServer` on an ephemeral port: park a listen via
  HTTP with a long `waitMs`, call `close()`, assert the listen response arrives (empty
  delivery) and `close()` resolves without waiting out the poll window.
- `send`+`ackThrough` — service-level: advances cursor exactly like `ack` (caps at max id,
  idempotent, rejects nothing valid), message still delivered, canonical send event carries
  `ackedThrough`; one **real-PhoneClient** round-trip test proving the field survives the
  wire (the client serializes fields explicitly — a fake-client or raw-fetch test would stay
  green while the real path drops it). CLI flag covered in `commands`-level test with the
  fake client.
- G1 is verified by measurement (impl.md evidence), not by tests — import topology is an
  implementation detail; asserting on it would couple tests to structure.
