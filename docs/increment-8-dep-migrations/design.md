# Increment 8 — dependency migrations (supersede Dependabot #16 + #17): design

Status: evidence-locked. Every version decision below is backed by a local reproduction or a
registry/experiment finding from the two investigation agents (2026-07-16) plus inline source
analysis; see `brief.md` for the pre-investigation state and hazard list.

## What & why

Dependabot PRs #16 (dev-dependencies group) and #17 (production-dependencies group) are real
migrations, not bot merges: they carry four majors (typescript 7, eslint 10, vitest 4, and the
express 4→5 / zod 3→4 / commander 14→15 trio). #16 is red in CI. We supersede both PRs with one
increment branch (`feat/ffl-8-dep-migrations`) so the migrations land reviewed, tested, and
bisectable; the bot PRs auto-close when main's manifests move past them.

## Investigation findings (evidence, condensed)

**#16's CI crash** (`TypeError: Cannot read properties of undefined (reading 'Cjs')`, all six
legs): reproduced locally on the PR branch. The thrower is
`@typescript-eslint/typescript-estree@8.64.0` reading `ts.Extension.Cjs` at module load inside
`pnpm lint`. TypeScript 7.0.2 (native-compiler generation) exports only
`{version, versionMajorMinor}` from its main entry — the classic JS API is gone from `"."`.
Bisection proved typescript is the **single culprit**: with TS held at 6.0.3 or 5.9.3 and every
other #16 bump kept, build/typecheck/lint/test are all green (83/83). typescript-eslint's latest
line (8.64.0; no v9 exists) caps `typescript <6.1.0`, so **TS 7 is categorically blocked
upstream** until typescript-eslint ships a native-API release. eslint 10 support exists only in
newer typescript-eslint 8.x (peer `^8.57 || ^9 || ^10`). vitest 4 and eslint 10 required **zero
config changes** — `vitest.config.ts`, `eslint.config.js`, `tsconfig.json` untouched.

**zod 4 × MCP SDK**: the lockfile already resolves `@modelcontextprotocol/sdk` to 1.29.0, which
is also the npm `latest`. SDK ≥1.23.0 declares `zod: ^3.25 || ^4.0` and branches internally on
`_zod` (v4) vs `_def` (v3) with a native zod-v4 `toJSONSchema` path. An end-to-end scratch
replica of our exact `registerTool(… inputSchema: schema.shape …)` pattern under SDK 1.29.0 +
zod 4.4.3 passed: correct JSON schema (`required: ["body"]` only, optionals preserved), valid
calls typed correctly, invalid calls rejected as validation errors, unknown keys stripped. Every
zod API the repo uses (4 files: contracts, mcp/tools, http/app, client) behaves identically;
the repo uses no `safeParse`/`.format()`/`.errors`/direct `.issues` reads. The only observable
delta is validation-error message **text** inside an unchanged `err.flatten()`
`{formErrors, fieldErrors}` structure — no code or test depends on the strings. zod 4 requires
TS ≥5.5 (satisfied). Verdict: **zod 4 is drop-in; no SDK bump, no shim, no `zod/v4` subpath
split.**

**express 4→5** (inline analysis of `src/http/app.ts`): all routes are literal or plain `:id` —
none of the path-to-regexp v8 breaking patterns. Error-middleware signature unchanged. Two
behavior points to handle: (1) express 5 forwards async handler rejections natively, so the
`asyncH` wrapper becomes dead weight; (2) in express 5 `req.body` is `undefined` (not `{}`)
when no body parser matched, so a body-less POST to an all-optional-body endpoint (checkin,
hangup) would flip from 200 to 422. The v5 default query-parser change ("extended"→"simple")
is irrelevant to our flat query schemas; body-parser 2's `entity.too.large` shape is covered
by the existing 413 test.

**commander 14→15** (inline analysis of `src/cli/index.ts`): v15 is ESM-only (repo is pure ESM —
`"type": "module"`, tsup `format: ['esm']`) and requires node ≥22.12. Our API surface
(subcommands, options, `parseAsync`) is unchanged; we use no `--no-*` options (the one
behavioral break).

## Approaches considered

1. **One branch, two phase-commits (chosen)** — prod-group commit, then dev-toolchain commit,
   one PR. Each phase is independently green for bisectability; one CI/review cycle; the
   `engines` bump spans both groups anyway (commander runtime + eslint dev).
2. Two separate PRs (prod, dev) — more isolation, double ceremony, no added safety: the phases
   are already independently verified.
3. Merge the bot PRs with fix-up commits — rejected by the brief; bot branches can't carry our
   source changes cleanly and #16 is red as-is.

## Version matrix (locked)

| Package | From | To | Rationale |
|---|---|---|---|
| commander | ^14.0.0 | **^15.0.0** | drop-in for our surface; ESM-only is moot (repo is ESM) |
| express | ^4.21.2 | **^5.2.1** | see source changes below |
| zod | ^3.25.0 | **^4.4.3** | drop-in, proven e2e through the MCP boundary |
| @modelcontextprotocol/sdk | ^1.15.0 | **^1.29.0** | hygiene floor: zod-4 peer support starts at 1.23.0; lockfile already resolves 1.29.0 (no resolve change) |
| @types/express | ^4.17.23 | **^5.0.0** | pairs with express 5 |
| typescript | ^5.8.0 | **~6.0.3** | newest classic-API TS inside typescript-eslint's `<6.1.0` cap; **tilde** so 6.1 can't float in and re-break lint |
| typescript-eslint | ^8.35.0 | **^8.64.0** | hygiene floor: the eslint-10 peer (`^10.0.0`) only exists in later 8.x; lockfile already resolves 8.64.0 |
| eslint | ^9.30.0 | **^10.6.0** | zero config changes needed |
| vitest | ^3.2.0 | **^4.1.10** | zero config changes needed; no typescript peer |
| @types/node | ^20.19.0 | **^26.1.1** | satisfied vitest's `>=24` types peer; typecheck green |
| engines.node | >=22 | **>=22.13.0** | commander 15 needs ≥22.12 (runtime); eslint 10 needs ^22.13 on the 22 line (dev); one floor covers both |

Not changed: tsup ^8.5.0, prettier ^3.6.0, better-sqlite3 ^12.2.0 (not in either PR).
Dockerfile needs nothing — `node:22-slim` floats to current 22.x (≥22.13).

## Source changes (the complete set)

All in `src/http/app.ts`; zod, commander, and the MCP layer need **no source changes**.

1. **Remove `asyncH`** (line 39) and unwrap its ~12 call sites — express 5 forwards async
   rejections to the error middleware natively. Keeping a redundant wrapper is exactly the
   replicating-pattern debt CLAUDE.md says to clear while it's cheap. The stale "express 4 does
   not catch async rejections" comment goes with it.
2. **Preserve body-less POST tolerance**: at the two all-optional-body routes — checkin
   (`CheckinInputSchema.parse`) and hangup (`HangupInputSchema.omit(...).parse`) — parse
   `req.body ?? {}` with a brief comment (express 5 leaves `req.body` undefined when no parser
   matched; v4 gave `{}`). Routes whose schemas have required fields (register, call, send)
   produce 422 either way and get no guard.
3. **Swap `err.flatten()` → `z.flattenError(err)`** in the 422 handler — same
   `{formErrors, fieldErrors}` output (probe-verified), but off the API zod 4 marks
   `@deprecated`. Cheap now; grows into a lint failure the day type-aware linting lands.

## Testing

The existing 83 behavior-level tests are the migration's safety net and MUST pass **unchanged**
— they assert wire contracts (status codes, error shapes, CLI behavior), not implementation, so
any test edit signals a real contract regression to investigate, not a test to update. One
**new** test (a new contract guarantee, not a modification): a body-less POST to an
all-optional-body endpoint (hangup, no `.send()`) succeeds — this pins the tolerance that
express 5 would otherwise silently drop, and covers the `?? {}` pattern at both sites.
Per-phase verification: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all green
after each phase commit.

## Phases

- **Phase 1 — production group**: commander 15, express 5 (+ @types/express 5, asyncH removal,
  body tolerance, flattenError), zod 4, SDK floor, engines bump. Full verify; commit.
- **Phase 2 — dev toolchain**: typescript ~6.0.3, typescript-eslint ^8.64.0, eslint 10,
  vitest 4, @types/node 26. Full verify; commit.
- Docs sweep folded into whichever phase touches them: README / site install guide if either
  names a node version floor (verify during implementation).

## Acceptance criteria

1. Both phases individually green: build + typecheck + lint + 83/83 tests, no peer warnings.
2. No test-file modifications except the one new body-tolerance test.
3. `asyncH` gone; error wire shapes unchanged (existing error-path tests prove it).
4. CI fully green on the PR (matrix + docker smoke + CodeQL).
5. After rebase-merge, Dependabot #16 and #17 close (auto, or manually with a comment linking
   the superseding PR).
6. `impl.md` records outcomes and the deferred ledger.

## Risks & mitigations

- **Express 5 latent path/parser behavior** not visible to static analysis → the behavior suite
  plus the docker CI smoke exercise every route; any drift fails loud.
- **Zod error-text delta** reaches HTTP clients in `details` message strings → structure is
  unchanged; no known consumer string-matches. Noted in impl.md as an observable-but-benign
  wire delta.
- **Future TS float breakage** → tilde pin on typescript is deliberate; revisit when
  typescript-eslint supports ≥6.1/7.x.

## Non-goals / deferred

- **TypeScript 7**: blocked upstream (typescript-eslint caps `<6.1.0`); revisit when a
  native-API typescript-eslint ships. Not our debt.
- Splitting zod usage onto `zod/v4` subpaths, or any MCP-boundary shim: proven unnecessary.
- npm publish/release of the bumped package: version stays 0.1.0; the next release picks the
  migrations up automatically.
