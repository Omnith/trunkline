# Increment 8 — dependency migrations (Dependabot #16 + #17): pre-brainstorm brief

Compact-resilient anchor, written 2026-07-16 before context compaction. Status: NOT started —
this brief captures the intel; the increment still owes the full workflow (brainstorm →
design → plan → plan-review gate → subagent execution with worktree isolation → reviews → PR).

## What these PRs are

Two Dependabot group PRs were deliberately left open by the walkthrough (2026-07-16) because
they are real migrations, not bot merges. Both keep auto-rebasing harmlessly.

**PR #17 — production-dependencies group:** commander 14→15, express 4→5, zod 3→4,
@types/express 4→5.

**PR #16 — dev-dependencies group:** @types/node 20→26, eslint 9→10, typescript 5→7,
vitest 3→4. **CI is red on this PR**: all six test legs fail with
`TypeError: Cannot read properties of undefined (reading 'Cjs')`, exit 2 — a toolchain
incompatibility, not a test failure.

## Known hazards to investigate FIRST (before writing the design)

- **zod 3→4 vs the MCP SDK (the critical path).** `src/core/contracts.ts` is the single
  schema source; `src/mcp/tools.ts` feeds `.shape` into `@modelcontextprotocol/sdk`
  `registerTool`, and the SDK (currently ^1.15.0 in package.json, 1.29.0 installed) declares
  its own zod peer/dependency expectations. Determine: does the installed/newer SDK accept
  zod v4 schemas? zod 4 ships `zod/v4` + `zod/v3` subpath exports — a possible bridge, but
  mixing versions across the `.shape` boundary is exactly where it would break silently.
  Outcome options: (a) SDK release exists that supports zod 4 → bump both together;
  (b) hold zod at 3 and split it OUT of #17 (merge commander/express only); (c) core on
  `zod/v4` with an explicit v3-compat shim at the MCP boundary. Decide with evidence.
- **express 4→5:** `src/http/app.ts` — v5 changes route-path matching semantics, makes
  `req.query` a getter, removes deprecated methods, and forwards async handler rejections
  natively (our `asyncH` wrapper may become redundant — evaluate, don't assume). Check the
  error-middleware signature and body-parser behavior against `app.test.ts`/`client.test.ts`.
- **TypeScript 5→7:** TS 7 is the native-compiler generation. Suspects for the `'Cjs'` crash:
  `typescript-eslint` (8.35 in repo — supports TS 5.x only; eslint 10 + TS 7 need
  typescript-eslint v9+/latest), tsup 8.5 (its dts/transform layer reads TS enums like
  `ModuleKind.Cjs`... repo does NOT emit dts, so the thrower might be vitest or
  eslint instead — REPRODUCE LOCALLY on the #16 branch and read the full stack first).
  Fallback: take @types/node/eslint/vitest bumps and hold TS at latest 5.x/6.x until the
  plugin ecosystem (typescript-eslint, tsup, vitest) declares TS 7 support.
- **vitest 3→4:** breaking config/API changes; suite is 83 tests, behavior-level, so churn
  should be config-only — verify `vitest.config.ts` and the testkit against the v4 migration
  guide.
- **commander 14→15:** read the changelog; CLI surface is pinned by `commands.test.ts` and
  `test/story.test.ts` — behavior must not shift (exit codes, option parsing).

## Approach constraints (from repo conventions + this session's practice)

- One increment, likely TWO phases: prod-group migration (needs design care: zod/express are
  load-bearing) and dev-toolchain migration (mechanical once versions are chosen). Tests must
  NOT be weakened — the suite is behavior-level and must pass unchanged except where a
  contract legitimately changes (there should be none: these are dependency bumps).
- Investigation-first tasks in the plan (reproduce #16's crash; probe SDK×zod4 compat in a
  scratch project) BEFORE locking versions in the design.
- Implementer subagents: `isolation: "worktree"` (see memory note).
- Supersede the Dependabot PRs with our own branch; they auto-close when main's manifests
  update past them.
- Plan-review gate as usual (two reviewers: architecture/contracts + test/toolchain).

## Board state at compact time (2026-07-16)

- trunkline.omnith.com LIVE (HTTPS enforced, cert issued); site deploys via pages.yml on
  main pushes touching site/**.
- npm `trunkline@0.1.0` published; release automation: tag `v*` push or workflow_dispatch →
  release.yml (OIDC trusted publishing; user has npm login for manual fallback; trusted
  publisher config on npmjs still pending user).
- Docs-aware CI gating live (docs-only PRs skip the matrix via the `changes` job).
- Open PRs: #16, #17 (this increment's subjects), #19 (user's own README tweak — merge
  needs the user's explicit word; it predates later README edits so it may need a rebase
  and could even be obsolete — CHECK its diff against current main before merging).
- Deferred ledger elsewhere: environment-gated publish job (release.yml hardening),
  volumi's client update to the trunkline-named CLI (its old clone still works),
  optional CodeQL enablement, cosmetic CGNAT-IP scrub in historical docs.
- Live server: docker container `trunkline` on the Windows box, healthy, running
  increment-5 code; agents desktop + volumi registered.
