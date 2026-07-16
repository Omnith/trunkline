# Increment 8 — dependency migrations: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for the
> implementation tasks in this plan. Steps use checkbox (`- [ ]`) syntax for tracking. If any
> step's actual result deviates from its Expected line, STOP, invoke
> superpowers:systematic-debugging, root-cause, and report back — do not improvise version
> changes; the matrix in design.md is evidence-locked.

**Goal:** Land the #16 + #17 dependency migrations (commander 15, express 5, zod 4, eslint 10,
vitest 4, @types/node 26, typescript ~6.0.3) on `feat/ffl-8-dep-migrations`, superseding both
Dependabot PRs, with the 83-test behavior suite passing unchanged plus one new tolerance test.

**Architecture:** No architectural change. The only source edits are in `src/http/app.ts`
(express-5 compat: drop `asyncH`, tolerate body-less POSTs, leave deprecated `.flatten()`).
Contracts, core, MCP, CLI, store are untouched. See `design.md` for the evidence behind every
version choice.

**Tech Stack:** pnpm 10.34.5 (invoke as `corepack pnpm …`), tsup, vitest, eslint flat config.

**Branch:** `feat/ffl-8-dep-migrations` (already created; design.md committed on it).

**Conventions (verbatim, from CLAUDE.md):** Do not use `cd` commands inline or the `git`
command's `-C <dir>` flag when already in the command's target directory. Never pass git pager
flags: no `git -c core.pager=...`, no `--no-pager`, no `GIT_PAGER=` overrides. When surfacing a
command's exit status, use exactly one canonical form: `echo "exit:$?"` — never variant
spellings; prefer relying on the harness's own exit reporting. Commit messages:
`type(root_folder:component): message`, no Co-Authored-By attributions.

---

### Task 1: Phase 1 — bump the production group in package.json

**Files:**
- Modify: `package.json:32-34` (engines), `package.json:49-55` (dependencies), `package.json:58` (@types/express)

- [ ] **Step 1: Apply the exact manifest edits**

```diff
   "engines": {
-    "node": ">=22"
+    "node": ">=22.12.0"
   },
```

```diff
   "dependencies": {
-    "@modelcontextprotocol/sdk": "^1.15.0",
+    "@modelcontextprotocol/sdk": "^1.29.0",
     "better-sqlite3": "^12.2.0",
-    "commander": "^14.0.0",
-    "express": "^4.21.2",
-    "zod": "^3.25.0"
+    "commander": "^15.0.0",
+    "express": "^5.2.1",
+    "zod": "^4.4.3"
   },
```

```diff
-    "@types/express": "^4.17.23",
+    "@types/express": "^5.0.0",
```

- [ ] **Step 2: Install**

Run: `corepack pnpm install`
Expected: lockfile updates; **no peer-dependency warnings** (the SDK 1.29.0 peer is
`zod: ^3.25 || ^4.0`). `@modelcontextprotocol/sdk` still resolves to 1.29.0 (floor bump only).

- [ ] **Step 3: Build + typecheck under the new prod set**

Run: `corepack pnpm build` then `corepack pnpm typecheck`
Expected: both exit 0. If typecheck fails, the prime suspect is the @types/express 4→5 type
surface (newly generic `Request`/`Response`, `req.query` typing, `res.locals`) — that is the
one empirical risk in this step; report the exact errors rather than casting around them.

- [ ] **Step 4: Run the suite — baseline under express 5 / zod 4 / commander 15**

Run: `corepack pnpm test`
Expected: **full suite green** (83 tests at time of writing — the gate is "all pass", not the
integer). Every existing test sends JSON bodies with content-type, so the
express-5 `req.body === undefined` change should not surface here. If ANY test fails, stop and
root-cause per the header rule; failures outside body-less/`req.body` semantics are
disqualifying evidence against the design and must be reported, not patched around.

*No commit yet — phase 1 commits at Task 4 (one green commit for bump + compat, one for the
asyncH refactor).*

### Task 2: TDD the body-less POST tolerance contract

Express 5 leaves `req.body` `undefined` when no body parser matched (express 4 gave `{}`), so a
body-less POST to an endpoint whose body schema is all-optional (checkin `PATCH /api/agents/me`,
hangup `POST /api/calls/:id/hangup`) would flip from 200 to 422. We pin the express-4 behavior
as an explicit contract.

**Files:**
- Test: `src/http/app.test.ts` (append inside `describe('http surface', …)`)
- Modify: `src/http/app.ts:126` (checkin parse), `src/http/app.ts:181` (hangup parse)

- [ ] **Step 1: Write the failing test** (uses the file's existing `boot`/`makeService`/
`provision`/`asJson` helpers — do not add new harness machinery)

```ts
  test('a body-less request is tolerated where every body field is optional', async () => {
    const h = makeService()
    const ghaToken = provision(h, 'gha-docker-runner')
    const volToken = provision(h, 'volumi')
    const base = await boot(h)
    const auth = (t: string) => ({ authorization: `Bearer ${t}` })
    // no content-type, no body: express 5 leaves req.body undefined; these routes must tolerate it
    const checkin = await fetch(`${base}/api/agents/me`, { method: 'PATCH', headers: auth(volToken) })
    expect(checkin.status).toBe(200)
    const call = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(ghaToken) },
      body: JSON.stringify({ to: 'volumi', subject: 'ci', body: 'first' }),
    })
    const { thread } = (await asJson(call)) as { thread: { id: number } }
    const hangup = await fetch(`${base}/api/calls/${thread.id}/hangup`, {
      method: 'POST',
      headers: auth(volToken),
    })
    expect(hangup.status).toBe(200)
  })
```

- [ ] **Step 2: Run it to verify it fails for the right reason**

Run: `corepack pnpm vitest run src/http/app.test.ts -t "body-less"`
Expected: FAIL — the checkin assertion fails with 422 (ZodError from `parse(undefined)`; vitest
stops at the first failing expect, so the hangup fetch never runs), proving express 5 dropped
the tolerance.

- [ ] **Step 3: Minimal implementation — guard the two all-optional-body routes**

In `src/http/app.ts`, checkin route:

```diff
-      const input = CheckinInputSchema.parse(req.body)
+      // express 5 leaves req.body undefined when no body was parsed; all fields optional here
+      const input = CheckinInputSchema.parse(req.body ?? {})
```

hangup route:

```diff
-      const body = HangupInputSchema.omit({ threadId: true }).parse(req.body)
+      // express 5 leaves req.body undefined when no body was parsed; all fields optional here
+      const body = HangupInputSchema.omit({ threadId: true }).parse(req.body ?? {})
```

Routes with required body fields (register, call, send) get NO guard — `parse(undefined)` and
`parse({})` both 422 there, so a guard would be dead code.

- [ ] **Step 4: Run the test to verify it passes, then the full suite**

Run: `corepack pnpm vitest run src/http/app.test.ts -t "body-less"` → PASS
Run: `corepack pnpm test` → full suite green (now +1 test), zero modified existing tests.

### Task 3: Swap the deprecated `err.flatten()` for `z.flattenError(err)`

zod 4 marks `ZodError.flatten()` `@deprecated`; `flattenError` produces the identical
`{formErrors, fieldErrors}` structure (probe-verified). The 422 `details` wire shape does not
change.

**Files:**
- Modify: `src/http/app.ts:7` (import), `src/http/app.ts:228` (422 handler)

- [ ] **Step 1: Apply the edits**

```diff
-import { ZodError } from 'zod'
+import { flattenError, ZodError } from 'zod'
```

```diff
-        error: { code: 'VALIDATION_ERROR', message: 'invalid input', details: err.flatten() },
+        error: { code: 'VALIDATION_ERROR', message: 'invalid input', details: flattenError(err) },
```

(`flattenError` is a top-level named export in zod 4. If typecheck disagrees, the fallback is
`import * as z from 'zod'` … `z.flattenError(err)` — verify, don't assume.)

- [ ] **Step 2: Verify**

Run: `corepack pnpm typecheck` then `corepack pnpm test`
Expected: exit 0; full suite green (the validation-failure test at `src/http/app.test.ts:73`
reaches the 422 handler; it asserts the error code, not the `details` shape — shape equivalence
rests on the probe evidence in design.md).

### Task 4: Commit phase 1a (bumps + compat)

- [ ] **Step 1: Build + lint before committing**

Run: `corepack pnpm build` then `corepack pnpm lint`
Expected: both exit 0 (build re-verified after the app.ts edits; eslint 9 + prettier are still
the installed dev toolchain in this phase).

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml src/http/app.ts src/http/app.test.ts
git commit -m "build(deps): commander 15, express 5, zod 4 - prod group with express 5 body tolerance"
```

### Task 5: Remove `asyncH` (behavior-neutral refactor)

Express 5 forwards async handler rejections to the error middleware natively; the wrapper is now
dead weight. **No test may change in this task** — if one fails, the refactor broke behavior.

**Files:**
- Modify: `src/http/app.ts` (delete lines 38-43; unwrap 12 call sites: register, mcp, agents,
  checkin, calls POST, calls GET, messages POST, calls/:id/messages POST, history GET, hangup,
  inbox, cursor)

- [ ] **Step 1: Pre-count the closers** (guards the unwrap)

The 12 wrapper closers all sit on bare lines (whitespace + `}),` and nothing else) — 11 of them
4-space-indented, and ONE 6-space-indented (the `/mcp` route, nested inside
`if (deps.mcpHandler)`). One more `}),` exists mid-line inside the hangup route's
`res.json(await service.hangup(…, { threadId, ...body }),)` argument — that one must NOT be
touched. Use `[[:space:]]`, not `\s` — GNU grep on Git Bash does not honor `\s` and would
report 0.

Run: `grep -n "^[[:space:]]*}),$" src/http/app.ts`
Expected: exactly 12 line numbers. If not 12, STOP and reconcile against the file before
editing anything.

- [ ] **Step 2: Delete the wrapper definition**

Remove this entire block (including its comment):

```ts
// express 4 does not catch async rejections; wrap every async handler
const asyncH =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next)
  }
```

- [ ] **Step 3: Unwrap all 12 sites**

Openers first — these two substring replace-alls are safe (the wrapped-arrow text appears
nowhere else):

- `asyncH(async (req, res) => {` → `async (req, res) => {` (11 sites)
- `asyncH(async (_req, res) => {` → `async (_req, res) => {` (1 site — GET /agents)

Closers site-by-site (the PRIMARY path — do not attempt a whole-file replace-all on `}),`; the
12 bare closers differ in indentation, 11 at 4 spaces and the `/mcp` one at 6, and the 13th
mid-line `}),` in the hangup `res.json(...)` must survive): walk the 12 line numbers from
Step 1 top to bottom and change each bare `}),` to `},`, preserving that line's indentation.
Use unique surrounding context (the route's last body line) when editing, since the closer
lines themselves are identical.

Example, register route, complete before/after:

```ts
  // before
  app.post(
    '/api/register',
    label('register'),
    asyncH(async (req, res) => {
      const input = RegisterInputSchema.parse(req.body)
      res.status(201).json(await service.register(input, 'http'))
    }),
  )
  // after
  app.post(
    '/api/register',
    label('register'),
    async (req, res) => {
      const input = RegisterInputSchema.parse(req.body)
      res.status(201).json(await service.register(input, 'http'))
    },
  )
```

Keep the `RequestHandler`, `Request`, `Response`, `NextFunction` imports — `label`, `auth`,
`noSession`, and the error middleware still use them. If `Request`/`Response` become unused
after the wrapper's deletion, remove exactly the now-unused names (typecheck/lint will say).

- [ ] **Step 4: Verify nothing remains and behavior held**

Run: `grep -n "asyncH" src/http/app.ts`
Expected: no matches.
Run: `corepack pnpm typecheck` then `corepack pnpm lint` then `corepack pnpm test`
Expected: all exit 0; full suite green with zero test-file changes. The validation-error and
domain-error tests (`app.test.ts:73` — ZodError thrown inside an async handler — and `:124` —
an awaited service call rejecting with a PhoneError) prove async rejections still reach the
error middleware. (The 413 test at `:111` fails upstream in the body parser and never touched
`asyncH`, so it is not evidence here.)

- [ ] **Step 5: Commit**

```bash
git add src/http/app.ts
git commit -m "refactor(http): drop asyncH - express 5 forwards async rejections natively"
```

### Task 6: Phase 2 — bump the dev toolchain

**Files:**
- Modify: `package.json:56-66` (devDependencies)

- [ ] **Step 1: Apply the exact manifest edits**

```diff
   "devDependencies": {
     "@types/better-sqlite3": "^7.6.13",
     "@types/express": "^5.0.0",
-    "@types/node": "^20.19.0",
-    "eslint": "^9.30.0",
+    "@types/node": "^26.1.1",
+    "eslint": "^10.6.0",
     "prettier": "^3.6.0",
     "tsup": "^8.5.0",
-    "typescript": "^5.8.0",
-    "typescript-eslint": "^8.35.0",
-    "vitest": "^3.2.0"
+    "typescript": "~6.0.3",
+    "typescript-eslint": "^8.64.0",
+    "vitest": "^4.1.10"
   }
```

The **tilde** on typescript is deliberate and load-bearing: typescript-eslint caps
`typescript <6.1.0`; a caret would let 6.1 float in and re-crash lint (design.md, investigation
finding). Do not "fix" it to a caret.

- [ ] **Step 2: Install**

Run: `corepack pnpm install`
Expected: lockfile updates; no peer warnings (typescript-eslint 8.64.0 peers
`eslint ^8.57 || ^9 || ^10` and `typescript >=4.8.4 <6.1.0`; vitest 4 has no typescript peer;
its `@types/node` peer `^20 || ^22 || >=24` is satisfied by 26).

- [ ] **Step 3: Full verify — investigation predicts zero config changes**

Run: `corepack pnpm build` then `corepack pnpm typecheck` then `corepack pnpm lint` then `corepack pnpm test`
Expected: all exit 0; full suite green. `vitest.config.ts`, `eslint.config.js`, `tsconfig.json`
untouched. If lint throws `Cannot read properties of undefined (reading 'Cjs')`, typescript
resolved outside 6.0.x — re-check Step 1's tilde.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build(deps-dev): eslint 10, vitest 4, types/node 26, typescript ~6.0.3"
```

### Task 7: Docs sweep — node version floor

**Files:**
- Modify: `README.md:76`

- [ ] **Step 1: Update the known mention** (runtime floor = commander 15's `>=22.12.0`)

```diff
-npm i -g trunkline    # Node >= 22; first install fetches a sqlite prebuilt, takes a few seconds
+npm i -g trunkline    # Node >= 22.12; first install fetches a sqlite prebuilt, takes a few seconds
```

- [ ] **Step 1b: Document the dev-only floor** — in the same dev/from-source section of the
README (adjacent to the `corepack enable` line at README.md:88), add one brief comment line:

```
# dev tooling (eslint 10) additionally needs Node 22.13+ on the 22.x line
```

This keeps the published `engines` runtime-honest while contributors still learn the real
toolchain floor (gate finding M1).

- [ ] **Step 2: Sweep for any other floor mentions**

Run: `grep -rn "Node >= 22\|Node 22\|node >=22\|node-22" README.md site/src docs/overview.md`
Expected: remaining hits are either the line just fixed, "ships with Node 22" (corepack note —
still true, leave it), or historical docs (leave those). Update only statements of the minimum
supported version. `Dockerfile` needs nothing (`node:22-slim` floats ≥22.13).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: node runtime floor 22.12, dev floor 22.13"
```

(Include `site/` files in the add only if Step 2 changed any.)

### Task 8: Push and open the PR

- [ ] **Step 1: Push**

Run: `git push -u origin feat/ffl-8-dep-migrations`

- [ ] **Step 2: Create the PR**

Run: `gh pr create --fill`
Expected: PR against main; CI runs the full matrix (package.json is code, docs gating does not
skip). Report the PR number and CI status back; the session handles review gates, merge, and
Dependabot supersession per the increment workflow.

---

## Self-review notes

- Spec coverage: every design.md source change (asyncH removal, body tolerance, flattenError)
  and every matrix row maps to a task; engines + docs floor covered by Tasks 1 and 7.
- Test integrity: exactly one new test (Task 2); Tasks 1, 5, 6 assert the existing suite passes
  unchanged. The new test asserts wire behavior via the public HTTP surface only.
- Type consistency: all edits shown against the current file contents at the stated lines.
