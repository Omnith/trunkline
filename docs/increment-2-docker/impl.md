# Increment 2 — implementation notes

## Decisions & deviations

- pnpm pinned at `pnpm@10.34.5` (exact, corepack). `pnpm.onlyBuiltDependencies:
  ["better-sqlite3", "esbuild"]` added per the plan-review gate — pnpm 10 blocks dependency
  lifecycle scripts by default, which would have silently skipped better-sqlite3's native
  binding fetch.
- `.prettierignore`: `package-lock.json` → `pnpm-lock.yaml` (plan-review gate; the generated
  lockfile is not prettier-formatted and lint would fail).
- Dockerfile deviates from design's `chown node:node /data /app` — chowns `/data` only
  (runtime never writes /app; root-owned code is safer). Flagged by both plan reviewers,
  accepted intentionally.
- `pnpm install` in the Dockerfile is NOT `--offline` (plan rev 2): better-sqlite3's install
  script downloads its linux prebuilt from GitHub Releases at install time regardless, and the
  flag suggested a hermetic build that doesn't exist. slim has no compiler fallback by design.
- compose port mapping uses single quotes (`'4747:4747'`) — repo prettier `singleQuote: true`
  applies to yaml in lint scope; functionally identical (execution deviation, sanctioned).
- CI test job bootstraps pnpm via the double `setup-node` + `corepack enable` pattern (single
  setup-node with `cache: pnpm` after corepack is known-flaky on Windows runners).

## Review findings & resolutions

### Plan-review gate (2026-07-14, two parallel Opus reviewers before execution)

- HIGH (both reviewers): pnpm 10 `onlyBuiltDependencies` blocker → fixed in plan rev 2, Task 1.
- HIGH (infra): `.prettierignore` lockfile swap → fixed in plan rev 2, Task 1.
- MEDIUM: GHCR first-publish is private by default (visibility flip required for anonymous
  pull — Task 6); robust CI pnpm bootstrap; bind-mount `/data` uid-1000 ownership note in
  README; `--offline` dropped as misleading; `gh run watch` race → headSha resolution with
  retry + red-leg guidance; README Task-5 step boundary conflict fixed; real PR body +
  explicit holistic review step; published-image pull-and-run (incl. `docker exec` invite)
  added as Task 6 Step 7.
- LOW (noted): arm64 leg ships un-smoked (QEMU cost) — arm64 healthy-run deferred to MacBook
  manual acceptance; no `busy_timeout` in SqliteStore (concurrent admin one-shots could rarely
  hit SQLITE_BUSY — pre-existing, more routine under docker; revisit if seen); PR double-runs
  the amd64 smoke (push + pull_request events) — accepted cost; GHA cache mode=max sizing noted.

## Deferred debt

- arm64 image is published without a runtime smoke (QEMU emulation cost); verified via MacBook
  manual acceptance instead. If arm64 regressions ever bite, add a QEMU arm64 health-only check.
- `SqliteStore` has no `busy_timeout`; docker makes concurrent admin one-shots routine.
- PR events double-build the amd64 smoke (pre-existing push+PR double-trigger).

## Verification evidence

- Tasks 1-2 (pnpm switch): all gates green locally under pnpm (typecheck/lint exit 0, 70 tests,
  tsup build) with the native binding built (no "Ignored build scripts" warning). CI matrix
  live-verified all four legs green: run 29384005973 (headSha 7e94505). rtk-proxy exit-code
  masking caught AGAIN on lint (prettier reflow of the new package.json block) — direct-command
  verification prevented shipping a red gate.
- Tasks 3-5 (docker + CI + README): local Docker Desktop smoke — compose config valid, image
  builds, health 200 on :47473, one-shot invite mints `ap-invite-…`. CI run 29384554498 (headSha
  bccb19e) green: docker job smoke passed with BOTH invite forms (one-shot + `docker exec`),
  GHCR login/push steps correctly SKIPPED off-main. Test matrix green in both runs.
- (filled at close) Post-merge publish run, GHCR tags, visibility flip, published-image
  pull-and-run.
