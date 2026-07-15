# Increment 3 — implementation notes

## Plan-review gate (2026-07-15, two parallel Opus reviewers before execution)

Both returned REVISE; plan rev 2 folds everything in. The gate caught two ship-broken-but-green
defects:

- **HIGH (arch): bare `releaseAll` would silently not work.** The listen loop re-checks
  `records.length > 0 || elapsed >= waitMs` after every wakeup; a shutdown wake has neither,
  so the handler re-parks for the rest of the window — reproducing the exact exit-137 hang
  (AC2) the increment fixes. Rev 2: `draining` flag in Waiters, consulted in the listen
  **exit condition** (in `wait()` it would busy-loop), plus a service-level red test that
  encodes the contract.
- **HIGH (both reviewers, independently): `PhoneClient.send` serializes only `{ body }`** —
  the planned CLI `--ack-through` would parse fine and silently never reach the wire, and
  both originally-planned tests (fake client; raw fetch) would stay green. Rev 2: client file
  in scope, field forwarded, and a real-PhoneClient round-trip red test as the load-bearing
  guard.
- MEDIUMs folded in: idempotent `close()` (`closing ??=`), signal handler exits 1 on close
  rejection (a swallowed rejection hangs to SIGKILL), keep-alive sockets reaped via unref'd
  `closeIdleConnections` interval (single call races the just-released response; undici pools
  keep the socket non-idle until flush), `ackedThrough` added to `PhoneEvent` unconditionally
  (spread emit means typecheck would never force it) + event assertion, shutdown test uses the
  real `GET /api/inbox?waitMs=` contract (`/api/listen` does not exist), send route is 201.
- LOWs: shebang check after tsup `splitting: true`; Task-1 guard is typecheck + manual
  serve/admin smoke (no suite coverage of those actions); `ackThrough .positive()` vs ack
  `.min(0)` asymmetry intentional; AC3-MCP discharged by `.shape` reuse by design.

Affirmed by the arch reviewer (no action): `releaseWaiters` on PhoneService is a legitimate
core seam (delivery-domain capability; shutdown orchestration stays in the composition root);
`advanceCursor` extraction is behavior-preserving and single-sources cursor semantics; the
lazy-CLI chunk boundary is clean (no static path from CLI entry to express/MCP-SDK/sqlite
after the two imports move); Docker/pnpm-prune unaffected by splitting; PID-1 signal handling
correct for `docker stop`.

## Decisions & deviations

- Task 4 (steering docs) executed inline by the orchestrating session rather than a dispatched
  implementer — two plan-specified content edits (README block, MCP listen description), gates
  run directly. No deviation from plan content.
- All red-first evidence captured per task (see execution reports): the Task 2 HTTP shutdown
  test hung the full 15s timeout pre-fix (proving the plan-gate HIGH-1 re-park), and the
  Task 3 client round-trip test failed pre-client-fix with core+HTTP already accepting the
  field (proving the wire drop both reviewers predicted).
- `advanceCursor` extraction validated by the pre-existing ack idempotency/cap tests passing
  unchanged — behavior-preserving refactor, no test modifications needed.

## Verification evidence (2026-07-15)

- Gates at head: tsc clean, tsup build clean (split chunks: `agentphone.js` 13.0K +
  `server-*.js` 20.9K + `sqlite-*.js` + 2 shared chunks, shebang intact), eslint clean,
  prettier clean, vitest 76/76.
- **AC1 (CLI ≤250ms):** full-process p50 against the live container — `inbox` 115ms,
  `phonebook` 117ms, `threads` 119ms (pre-increment baseline: ~610ms p50 on the same box,
  `docs/investigations/2026-07-15-read-latency.md` Evidence B). ~5.2x.
- **AC2 (graceful stop):** container rebuilt from this branch (`docker compose up -d
  --build`), health 200, then `docker stop` completed in **0.68s wall / exit 0** (baseline:
  10s grace + SIGKILL, exit 137). Canonical `shutdown` event emitted to the jsonl
  (`durationMs: 17`). Container restarted healthy; data volume preserved
  (desktop/volumi registrations intact).
- **AC3 (one-round reply+ack):** service test (cursor advance + cap = maxMessageId + peer
  delivery + `ackedThrough` on the send event), real-PhoneClient round-trip test (inbox
  clears in one round over the wire), `sendTo` forwarding test. All green.
- **AC4 (steering):** README "Keep it fast" block (4 rules) + MCP `listen`/`send`
  descriptions updated.
- **AC5:** suite 76/76, no existing test modified.
- Cleanup: bench-a/b/c/d revoked; phonebook back to desktop + volumi.

## Final holistic review (2026-07-15, two parallel Opus reviewers over main..HEAD)

Both MERGE-READY, zero HIGH/MEDIUM. All plan-gate fixes verified present in code (drain flag
in the listen exit condition, client wire forwarding, idempotent close, reaper lifecycle,
PhoneEvent.ackedThrough, no `as any`); lazy boundary verified at source AND built-artifact
level; surfaces consistent; gates independently re-run. LOWs applied in `561a1ea` (all on the
load-bearing shutdown path, per the tech-debt stance): try/finally so the close promise always
settles even if store/emitter throw; 5s unref'd exit-fallback timer in the signal handler
(hang → exit 1 before docker's grace SIGKILLs); one-way-latch comment on `Waiters.draining`;
test assertion that double-close emits exactly one canonical `shutdown` event. LOWs accepted
without change: CLI numeric-flag validation stays server-side (existing convention); the
cursor-probe-via-ack test style noted as methodology-compliant.

## Deferred debt

- Waiter release on **client disconnect** (mid-poll socket drop leaves a parked waiter until
  its window elapses) — pre-existing increment-1 debt, unchanged here; the drain path only
  covers shutdown. Revisit if waiter buildup is ever observed.
- H3 (Mac client-side timings) still unmeasured — checklist lives in the investigation doc;
  the lazy-CLI fix helps volumi regardless. Ask volumi to run it next session.
- MCP `listen` default waitMs stays 25000 (description now warns loudly); revisit only if
  agents are still observed using listen-as-read after the steering docs land.
