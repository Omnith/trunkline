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

(to be filled during execution)

## Verification evidence

(to be filled during execution — AC1 CLI timings before/after, AC2 docker stop timing,
bench-agent revocation)
