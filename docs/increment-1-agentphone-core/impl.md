# Increment 1 — implementation notes

## Decisions & deviations

- 2026-07-14 (plan-review gate, before any code): dropped the plan-added `threadId` filter from
  `listen`/`inbox` (design never had it) — a filtered listen returning an advancing cursor would
  silently skip unseen messages in other threads when acked. `history` is the per-thread read.
- Long-poll window is driven by wall-clock time; the injected `Clock` port is for domain
  timestamps/TTL/event `ts` only (a FakeClock-driven deadline made the timeout branch unreachable
  under real timers).
- Provisioning functions (`createInvite`/`addAgent`/`revokeAgent`) live in `src/core/provisioning.ts`
  (pure port consumers), not in the CLI — the CLI admin commands and the test harness both reuse them.
- MCP handler is injected into `buildApp` at the composition root (`src/http/server.ts`); the HTTP
  adapter does not import the MCP adapter.
- Test harness lives in `src/testkit/` (above core), not inside `src/core/` — core keeps zero
  outward imports.

## Review findings & resolutions

### Plan-review gate (2026-07-14, two parallel Opus reviewers before execution)

HIGH (all fixed in plan rev 2):
1. Filtered `listen` + single global cursor = silent message loss → `threadId` removed from
   listen/inbox everywhere; design.md updated with the rationale.
2. Long-poll deadline computed from injected `Clock` while parking on real timers → unreachable
   timeout branch under FakeClock (one planned test would hang) → listen now uses wall-clock for
   the poll window; explicit timeout-empty test added.
3. eslint `no-unused-vars` (strict preset) fails on the mandatory 4-arg express error handler →
   `argsIgnorePattern: '^_'` added in Task 1.
4. prettier check scope hit `dist/` and hand-written docs (no `.prettierignore`) → `.prettierignore`
   added; markdown excluded from prettier.
5. TDD inversion (whole PhoneService landed in one task, tests trailing) → Tasks 6–8 resequenced
   into three red-green verb clusters (identity/provisioning → conversations+delivery → lifecycle).

MEDIUM (all fixed in plan rev 2): http→mcp import replaced by injected handler; testkit moved out
of core; `authenticate(token, surface)` + per-surface auth middleware; boundary validation failures
(422/413) now emit canonical events; CI matrix task added (windows+macos, Node 20/22); MCP test now
exercises `send`+`listen` tools and asserts the 25s default via the tool schema; GET/DELETE /mcp
return 405; 64KB body cap and payload-too-large mapping tested; CLI logic (stdin body, send --to,
ack --all, exit codes) extracted into tested functions; `resolvePeerThread` peer-exclusion tested.

LOW (accepted/noted): delivery batch cap named + documented (500); message-id monotonicity
documented as contract; `JsonlEmitter` uses `appendFileSync` on the hot path (fine at 2-agent
scale — revisit if event volume grows); `ClientError` reused for CLI-local resolution errors
(naming nit); design "constant-time compare" wording corrected to hash-lookup.

### Phase 1 checkpoint (2026-07-14, parallel spec-conformance + code-quality reviewers, commits 9685424..0899a1d)

- Spec-conformance: ✅ compliant, no findings at any severity. All four gates independently re-run
  and genuinely green (34 tests); dependency DAG verified inward-only from actual imports; subtle
  contracts (cursor semantics, wall-clock long-poll, reopen-on-send, lazy TTL, invite single-use,
  one-event-per-op, ack idempotence + cap) spot-checked line by line.
- Code-quality: APPROVE. Zero Critical/Important. Five Minor items; pull-forward cleanup applied
  for two (hoisted double `clock.now()` in `authenticate`; shared `HOUR_MS` constant replacing
  duplicated 24h magic numbers). Remaining Minors accepted as-is: `call`'s extra `getThread`
  re-read (harmless), slight invite-expiry test overlap (distinct code paths), see ack note below.
- **Load-bearing note for CLI work (Task 13+):** `ack` clamps to the *global* `maxMessageId()`,
  which does not protect a client that acks a too-high id from skipping unseen lower-id voicemail.
  Any ack sugar (`ack --all`) MUST derive its value from the delivery cursor returned by
  `listen`/`inbox` (`ListenOutput.cursor`) — never from a global max. The plan's `ackAll` already
  does this; keep it that way.
- Implementer reports of the rtk proxy masking exit codes were probed by the spec reviewer and NOT
  reproduced (a forced eslint failure propagated exit 2). Direct-command verification retained as
  practice regardless.

### Phase 2-3 checkpoint (2026-07-14, parallel spec-conformance + code-quality reviewers, commits 599535c..a29f489)

- Spec-conformance: ✅ compliant, no findings. All 11 HTTP routes match the design table; the
  one-event-per-request contract traced across success/validation/auth paths; http→mcp handler
  injection verified (composition root is the sole mcp importer); the single sanctioned test
  deviation (type-only `textOf` param via the SDK's `callTool` return type) changed no assertions.
- Code-quality: APPROVE, tests judged free of implementation coupling. One Important + five Minor:
  - **Fixed (fix commit after a29f489):** I1 MCP tool schemas now reuse the core zod contracts
    (`*InputSchema.shape`) instead of inline re-declarations — closes the agent-name validation
    divergence between surfaces (`listen` keeps its deliberate MCP-specific 25s default); M1
    case-insensitive Bearer scheme; M2 `startServer` rejects on bind errors (EADDRINUSE previously
    hung the promise); M4 uniform JSON 404 catch-all for unmatched routes; M6 listen-default
    assertion pins the published schema default instead of a substring match.
  - **Accepted as-is:** M3 boundary events for pre-route failures (413) carry `op: req.path`
    rather than a verb label — graceful degradation, noted for anyone querying events by `op`;
    M5 `McpHandler` carries `service` although the composition root could close over it — seam
    judged non-leaky; revisit if a third surface appears.

## Deferred debt

- `JsonlEmitter` synchronous append on the request path — acceptable now, swap to buffered/async
  sink if agent count or event volume grows.
- No retention/pruning story for `messages`/events jsonl (explicit non-goal this increment).

## Verification evidence

Captured during execution of Tasks 15–17 (2026-07-14, branch `feat/ffl-1-agentphone-core`,
Windows host, Node local toolchain). All gates run as direct commands with real exit codes.

- **`npm run build`** — exit 0. tsup ESM build success; artifact `dist/agentphone.js` (41.47 KB,
  sourcemap 89.97 KB), target node20.
- **`npm run typecheck`** — `tsc --noEmit`, exit 0, no diagnostics.
- **`npm run lint`** — `eslint . && prettier --check .`, exit 0 ("ESLint: No issues found";
  prettier check passed).
- **`npm test`** — `vitest run`, exit 0. 14 test files, **67 tests passed** (up from 66: the new
  end-to-end story test). Includes `test/story.test.ts` (the whole story) and `test/mcp.test.ts`.
- **Story test (Task 15)** — `npx vitest run test/story.test.ts` → PASS (1/1, ~350 ms). Exercises
  register → parked listen wakes on call → ack → voicemail while not listening → **server restart
  with unacked voicemail surviving** (SqliteStore persistence) → ack → hangup emits a system message
  → wrong-token 401 on `/api/agents` → canonical `op`/`outcome` events written as jsonl.
- **Built-CLI smoke (Task 17, exit-code contract)** — against `dist/agentphone.js` on port 47470
  with a temp DB/events file: `admin invite` minted a single-use code; `serve` came up
  ("agentphone listening on 127.0.0.1:47470"); `register --name smoke-test` printed a one-time
  `ap_…` token; **`listen --wait 1` printed "no messages (listen timed out)" and exited with code 2**
  (timeout, nothing to deliver — the empty-window ring contract). Serve stopped, temp DB/events
  files removed afterward.
- **CI matrix (Task 16)** — `.github/workflows/ci.yml` added: `windows-latest` × `macos-latest`,
  Node 20 & 22, running `npm ci` → build → typecheck → lint → test. Actual cross-OS runs execute on
  push to `main` / pull_request (GitHub Actions) — not runnable on the local host; wiring verified by
  inspection only.

### Execution deviations (Tasks 15–17)

- Smoke test wrote its temp DB/events to a scratchpad subdirectory rather than literally
  `$env:TEMP` — location-only deviation, behavior identical; artifacts deleted after the run.
- No production code changed in this batch: Task 15 pins existing behavior (characterization test
  over the already-complete Tasks 1–14 stack), so it passed on first run rather than red→green. The
  test asserts only public-interface behavior (client methods, HTTP 401, jsonl event shape), no
  implementation coupling.
