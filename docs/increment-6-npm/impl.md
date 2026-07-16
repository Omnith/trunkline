# Increment 6 — implementation notes

## Plan-review gate (2026-07-16, one combined infra+supply-chain reviewer)

REVISE → rev 2. The blocker: **Node 22's bundled npm is 10.x; tokenless OIDC trusted
publishing needs npm ≥ 11.5.1** — the workflow would have failed at auth with no token
configured. Fixed with an `npm install -g npm@latest` step before publish (the
npm-documented flow; `pnpm publish` was considered but its OIDC support was less certain).
Also folded: npmjs SVG rendering is unreliable → committed `assets/banner.png` (1600×312,
alpha) and the README references it absolutely; `--access public` kept though redundant for
an unscoped name; `author` added. Verified sound by the reviewer: `files: ["dist"]` beats
`.gitignore` for packing; split chunks travel together; `prepublishOnly` never fires on
install/build so Docker is untouched; corepack makes pnpm available to `prepublishOnly`
under `npm publish`; workflow permissions/pins/org-policy all clean.

## Decisions & deviations

- Description mirrors the repo tagline verbatim (user request).
- Sourcemaps ship in the tarball (~92 KB) — accepted; lean-tarball option noted for later.
- Deferred (reviewer MED-2): gate the publish job behind a protected `environment:` for a
  manual-approval second factor between "create release" and "public publish". Revisit if
  collaborators are ever added; today Omnith is the sole writer.
- Banner absolute URL 404s until the repo is public — accepted sequencing (flip precedes
  release).

## Verification evidence (2026-07-16)

- Gates: tsup/tsc/eslint/prettier clean, vitest 83/83.
- **AC1**: `npm pack --dry-run` → 13 files, 44.6 kB tarball: dist/* (+maps), README,
  LICENSE, package.json. No src/tests/docs/db.
- **AC2**: consumer-flow smoke — `npm install ./trunkline-0.1.0.tgz` into a temp project,
  `./node_modules/.bin/trunkline --help` prints usage (deps incl. better-sqlite3 prebuilt
  installed cleanly).
- **AC3**: release.yml — `permissions: {}` top-level, job-scoped `contents: read` +
  `id-token: write`, SHA pins identical to ci.yml, GitHub-owned actions only, no secrets,
  `persist-credentials: false`; does not run on push/PR (release-published trigger only).
- **AC4**: README relative links intact; banner now absolute PNG (renders on GitHub and
  npmjs once public).

## Handoff — user-side steps to first publish

1. Flip repo public, then GHCR package visibility.
2. Either configure npm trusted publishing (npmjs → package/org settings → Trusted
   publisher → GitHub Actions: `Omnith/trunkline`, workflow `release.yml`) and cut
   `gh release create v0.1.0`, or `npm login` locally and run `npm publish --access public`
   once; the workflow covers releases thereafter.
