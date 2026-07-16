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

(to be filled during execution)

## Verification evidence

(to be filled during execution)
