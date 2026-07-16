# Increment 6 — npm publish readiness (public launch prep)

## What & why

The repo is going public and `trunkline` (unscoped) is free on npm. Publishing turns the
agent-side install from clone+build+link into `npm i -g trunkline` / `npx trunkline` — the
single biggest onboarding friction left. This increment makes the repo publish-ready; the
first actual publish and the npm-side trusted-publisher configuration are user actions
(interactive login / one-time settings), deliberately out of scope.

## Goals

- **G1 — publishable package.json**: drop `private: true`; add `description`, `license`
  (MIT, matches LICENSE), `repository`/`homepage`/`bugs` (Omnith/trunkline), `keywords`,
  `files: ["dist"]` (npm auto-includes README/LICENSE/package.json), and
  `prepublishOnly: pnpm run build` so a stale dist can never ship.
- **G2 — release workflow**: `.github/workflows/release.yml` — on GitHub release published,
  build gates then `npm publish --provenance --access public` via **OIDC trusted publishing**
  (no long-lived npm token secret; `id-token: write` only in that job; actions SHA-pinned per
  org policy). Inert until the user configures the trusted publisher on npmjs.
- **G3 — README launch touches**: banner `src` → absolute raw.githubusercontent URL (renders
  on npmjs, which serves the README without repo-relative assets); private-registry note →
  plain public pull; agent install section leads with the npm path, clone+build kept as the
  dev path.

## Non-goals

- The publish itself, npm account/org/trusted-publisher setup, 2FA — user-side.
- Version bumps/changelog automation (0.1.0 is the first release; revisit at 0.2).
- GHCR/package visibility (separate user clicks).

## Acceptance criteria

- AC1: `npm pack --dry-run` lists exactly dist/* + README.md + LICENSE + package.json — no
  src, tests, docs, db files.
- AC2: `npx tsx`-free: the packed bin runs on a bare Node 22 (`node dist/trunkline.js
  --help` from the pack contents; better-sqlite3 is a declared dep so install-time prebuilds
  handle the native part).
- AC3: release workflow passes actionlint-level scrutiny (SHA-pinned, least-privilege
  permissions, no secrets), and CI stays green (the new workflow doesn't run on push/PR).
- AC4: README renders correctly on GitHub (relative links intact) with the absolute banner.

## Test strategy

Config/docs increment: no behavior surface — verification is AC1's pack listing, the gates,
and one manual bin smoke from the packed tarball. No new unit tests.
