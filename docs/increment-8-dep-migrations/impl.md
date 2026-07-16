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

**Task 1 STOP-gate halt (worktree implementer, by design):** the prod-group bump left exactly
one test red — `server.test.ts` bind-failure rejection (5s timeout + null `.port` TypeError).
Root-caused from the installed express 5.2.1 source: `app.listen` now registers the listen
callback as a `server.once('error', done)` handler (v4 fired it only on `'listening'`), so on
EADDRINUSE our callback ran with an unbound socket, threw inside the emitter, and blocked our
own `'error'` listener — the promise never settled. The implementer reported instead of
patching (the design had claimed app.ts was the complete source-change set — it wasn't).
Resolution: design.md source-change item 4 + plan Task 1b added (callback takes `(err?: Error)`
and bails; existing test is the red TDD test). Everything else in Task 1 was green: install
clean, build/typecheck pass, 82/82 other tests. This is the increment's one design deviation.

**Task 1b (the authorized fix):** listen callback now takes `(err?: Error)` and bails early;
the pre-existing bind-failure test went red (timeout + null `.port`) → green (~140ms) with no
test edits. Full suite 83/83 at that point.

**Phases landed (worktree implementer, resumed):** four commits, each independently green —
`33b2442` prod group (commander 15 / express 5 / zod 4 / SDK floor / engines >=22.12.0 / body
tolerance + its one new test / flattenError / server.ts guard), `d8e6cbf` asyncH removal,
`e81406f` dev toolchain (TS ~6.0.3 / typescript-eslint 8.64 / eslint 10.7 / vitest 4.1.10 /
@types/node 26), `0532736` docs floors. Final verify at tip: build + typecheck + lint + test
all exit 0, **84/84**, zero existing-test modifications.

**Deviations during execution (both prettier-only, behavior-neutral):**
1. The plan's verbatim new test had one line over `printWidth: 100`; prettier's exact wrap was
   applied to that single line.
2. Unwrapping `asyncH` let prettier's last-argument hugging collapse the route expressions, so
   the refactor commit also carries a reformat of the unwrapped route registrations
   (`prettier --write`, the formatter of record; the rest of the file was already
   prettier-clean and is byte-identical). Error-path tests (ZodError-in-async, PhoneError
   rejection) prove async rejections still reach the error middleware.

**Observations:** the `~6.0.3` tilde did its job during install (pnpm reported "7.0.2 is
available" and correctly did not float); lockfile churn was large but expected (express 4→5
subtree swap −317 lines; dev-toolchain swap +239/−453); pre-existing transitive
`prebuild-install@7.1.3` deprecation carried through (owned by better-sqlite3, untouched);
vitest 4 reporter labels changed cosmetically.

## Checkpoint reviews + final verification

- **Spec-conformance (opus): APPROVE, no HIGH/MEDIUM.** All eleven matrix rows byte-exact; all
  four source items landed as designed; `d8e6cbf` verified route-by-route as zero semantic
  change; test-integrity gate clean (one added test, zero existing-test churn); commit
  staging/messages exact; no attribution trailers. One LOW: this log's reformat wording (fixed
  above).
- **Code-quality (opus): APPROVE, no HIGH/MEDIUM.** Checklist sweep clean (no `as any`, deps
  flow inward, lazy init preserved, canonical events undisturbed); server.ts guard verified
  minimal + truthful against the installed express source, promise settles exactly once on all
  three paths (success / bind failure / error-after-listen); guards precisely placed per
  contracts; manifests/lockfile consistent (TS held at 6.0.3, eslint 10.7.0, @types/express
  5.0.6).
- These two reviews covered the complete increment diff against design/plan/overview and the
  conventions — the increment ran as a single implementation dispatch, so the checkpoint pass
  and the final holistic pass coincide in scope; no separate third review was run.
- **Independent session verification** (fresh install in the primary tree): build + typecheck +
  lint + test all exit 0, 84/84 under vitest 4.1.10.
