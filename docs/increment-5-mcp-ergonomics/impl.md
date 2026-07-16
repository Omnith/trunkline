# Increment 5 — implementation notes

## Plan-review gate (2026-07-16, two parallel Opus reviewers before execution)

Both REVISE; plan rev 2 folds everything in. The two big ones, found independently by both:

- **The XOR would have been silently unenforced on MCP.** The plan claimed "core enforces on
  parse" — false: `service.send` trusts pre-parsed input, and the MCP SDK re-wraps `.shape`,
  dropping any zod refine. Both-fields input would silently prefer `threadId`; neither-field
  would produce a misleading `NOT_FOUND: no thread with "undefined"`. Rev 2: the schema
  stays a plain object (all `.omit`/`.shape` consumers untouched — also fixes the
  Task-1-can't-go-green sequencing hole) and the XOR + self-send guards live in
  `service.send`, the one point every surface shares; tested through service behavior, not
  schema shape.
- **The core resolver silently dropped the CLI's ambiguity guard.** Multiple open threads
  with the same peer would auto-route to latest-active instead of erroring — an untested
  delivery-routing change. Rev 2 preserves the guard in core (`AMBIGUOUS_THREAD`, HTTP 409,
  ids listed), makes the open-pool TTL-aware (`effectiveStatus`, matching every other read
  path), and pins it all in core tests (including a TTL case and an other-peer exclusion
  case, both of which the deleted CLI tests used to pin).
- Other folds: `ack` on `listen` only — `inbox` keeps an honest `readOnlyHint` (a
  cursor-advancing option under a read-only label would let annotation-honoring harnesses
  mutate ungated); the path route's contract stated flatly
  (`omit({threadId: true, to: true})`, `to` enters HTTP only via the new `/api/messages`);
  sendTo tests declared rewritten-not-kept with exact new assertions; one raw-fetch test
  retained on the old path route (loses client exercise after PhoneClient switches);
  `mcp.test.ts` ten-verbs assertion → eleven; NOT_FOUND steering message asserted;
  instructions asserted via `client.getInstructions()`; AC6 measurement made deterministic
  (counted JSON-RPC exchange vs constructed baseline) with `claude -p` demoted to secondary
  realism evidence.

## Decisions & deviations

- Task 1: the "HTTP status map" edit landed in `errors.ts` (the `httpStatus` record is total
  over the code union; `app.ts` consumes it generically) — `app.ts` untouched. Type-only
  ripple into `commands.test.ts` (SendInput widening) fixed with the file's existing
  annotation pattern; those tests were rewritten in Task 2 anyway.
- Task 2: the raw-fetch retention test for `/api/calls/:id/messages` landed in `app.test.ts`
  (its harness is raw-fetch); `client.test.ts` keeps exercising only `/api/messages`.
- Task 3: implemented the plan's INSTRUCTIONS verbatim, which still said `listen/inbox
  {ack:true}` — the implementer flagged the contradiction with the rev-2 listen-only scope;
  fixed in `e80fe7c` (manual text now matches shipped behavior).
- `snapshot` emits three canonical sub-events (phonebook/threads/listen), no snapshot-level
  event — deliberate; a snapshot peek is indistinguishable from a listen(0) in the jsonl.

## Verification evidence (2026-07-16)

- Gates at head: tsup/tsc/eslint/prettier clean, vitest **83/83**.
- Deployed to the live container (`docker compose up -d --build`) — healthy, registrations
  intact (code-only rebuild, volume untouched).
- **AC6 primary (deterministic, live server, throwaway bench-e/f):** canonical exchange =
  **2 tools/call vs constructed baseline 6** — state check `snapshot` (1 vs
  phonebook+threads+inbox 3), reply+ack `send {to, ackThrough}` (1 vs
  threads+send{threadId}+ack 3). Server RTT 6.3/6.4ms per call. One-round semantics proven
  end-to-end: sender's inbox cleared by the piggyback, peer received the reply, `hint`
  rendered with the live cursor. `initialize` served the 624-char instructions
  (contains 'listen WAITS').
- **AC6 secondary (realism):** headless `claude -p` with the trunkline MCP, prompted for a
  state check with all four read tools allowed — the model chose **`snapshot`, exactly 1
  tool call**, 19.3s total session (the pre-increment probe spent 3 calls / 28s on the same
  class of task). Steering works.
- bench-e/bench-f revoked after measurement.
