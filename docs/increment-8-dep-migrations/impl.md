# Increment 8 — dependency migrations: implementation notes

Running log. Final outcomes and verification evidence appended at the end of the increment.

## Investigation phase (2026-07-16, two parallel agents — evidence in design.md)

- **#16 'Cjs' crash**: reproduced; thrower is `@typescript-eslint/typescript-estree` reading
  `ts.Extension.Cjs` at module load under TS 7 (whose main entry now exports only version
  info). Bisection: typescript is the single culprit; TS 7 is blocked upstream
  (typescript-eslint caps `<6.1.0`, no v9 exists). Proven matrix: TS ~6.0.3 + eslint 10.6 +
  vitest 4.1.10 + @types/node 26 — zero config changes, full suite green.
- **zod 4 × MCP SDK**: drop-in. Installed SDK 1.29.0 (= npm latest) peer-supports zod ^4 with a
  native v4 JSON-schema path; e2e replica of our `registerTool(.shape)` pattern preserved the
  required/optional contract; only validation message *text* changes inside an unchanged
  `flatten()` structure. No SDK bump, no shim.

## Plan-review gate (two parallel opus reviewers, both APPROVE-WITH-FIXES)

Architecture/contracts reviewer — findings and resolutions:

- **M1 engines conflation** (the substantive one): `>=22.13.0` baked the dev-only eslint floor
  into the published runtime contract; a Node 22.12 consumer would hit EBADENGINE over a linter
  they never install. → engines now `>=22.12.0` (commander 15's true runtime floor); dev floor
  documented in README instead.
- L1 `/mcp` body path not addressed in design → note added (415 either way on the only delta).
- L2 docker-smoke coverage overstated in risks → attribution corrected to the vitest suite.
- L3 closer replace-all indentation-fragile → site-by-site unwrap made the primary path.
- L4 exact test counts as gates → rephrased to "all green, zero existing-test edits, one new".
- L5 @types/express 5 type surface flagged as the empirical watch item → noted in Task 1.
- Verified (highlights): asyncH removal behavior-neutral (express 5's internal
  `Promise.resolve(ret).catch(next)` matches the wrapper); emit paths undisturbed;
  `flattenError` confirmed a real zod-4 top-level export with identical output shape; checkin +
  hangup confirmed the ONLY all-optional-body routes; no existing test hits
  `req.body === undefined`; commander surface safe; floor bumps are no-resolve-change.

Plan-quality/test-strategy reviewer — findings and resolutions:

- **HIGH grep `\s`** returns 0 on Git Bash GNU grep, stranding the executor at the Task 5
  safety gate → `[[:space:]]`.
- **MEDIUM 6-space `/mcp` closer** would survive a 4-space replace-all, breaking the route →
  folded into the site-by-site rewrite.
- LOWs: miscited `:111` as async-forwarding evidence (body-parser throws upstream of asyncH) →
  dropped; unobservable "both fetches 422" expectation → reworded (vitest stops at first
  failing expect); phase-1a commit lacked a build re-verify → added; `refactor(src:http)` →
  `refactor(http)` per practiced house style; flatten-equivalence coverage wording tightened.
- Verified (highlights): all diffs/line refs byte-accurate; suite = 83 tests (84 after); TDD
  red/green ordering sound; per-commit staging complete; every commit green and bisectable; the
  new test couples only to the public HTTP surface.

## Execution

(appended as phases land)
