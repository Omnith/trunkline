# Increment 6 — npm publish readiness: implementation plan

> Config/docs increment (no behavior surface): gates + AC1 pack listing + packed-bin smoke
> replace TDD. Branch `feat/ffl-6-npm-publish`.

### Task 1: package.json publishing fields

```jsonc
// remove: "private": true
// add:
"description": "Allow agents on different machines to talk to one another via HTTP or MCP.",
"license": "MIT",
"repository": { "type": "git", "url": "git+https://github.com/Omnith/trunkline.git" },
"homepage": "https://github.com/Omnith/trunkline#readme",
"bugs": "https://github.com/Omnith/trunkline/issues",
"keywords": ["agents", "mcp", "claude-code", "agent-communication", "messaging", "cli"],
"files": ["dist"],
// scripts gains:
"prepublishOnly": "pnpm run build"
```

- Verify: `npm pack --dry-run` → dist/* + README.md + LICENSE + package.json only (AC1).
- Smoke: `npm pack`, extract to temp, `node <tmp>/package/dist/trunkline.js --help` (AC2), delete tarball.
- Commit: `build(npm): publishable package metadata - files whitelist, prepublishOnly build`

### Task 2: release workflow

`.github/workflows/release.yml` (SHA pins copied from ci.yml; job-scoped permissions):

```yaml
name: release
on:
  release:
    types: [published]

permissions: {}

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # npm OIDC trusted publishing / provenance
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck && pnpm run lint && pnpm test
      - run: npm publish --provenance --access public
```

- Note: inert until the user configures the trusted publisher for `trunkline` on npmjs
  (Settings → Trusted publisher → GitHub Actions: Omnith/trunkline, workflow release.yml).
  First-ever publish may instead be done locally after `npm login` (see impl.md handoff).
- Commit: `ci(release): npm trusted publishing with provenance on github release`

### Task 3: README launch touches

- Banner: `src="assets/banner.svg"` → `src="https://raw.githubusercontent.com/Omnith/trunkline/main/assets/banner.svg"` (npmjs renders the README without repo files).
- Private-registry note → public pull one-liner.
- Client install section: lead with `npm i -g trunkline` (or `npx trunkline`), keep the clone+build path labeled "from source (dev)".
- Commit: `docs: npm install path, public image pull, absolute banner for npmjs render`

### Task 4: verification + PR

- Gates (direct): build/typecheck/eslint/prettier/vitest.
- impl.md evidence (pack listing verbatim, smoke output). PR, CI green, merge `--rebase`.
- Post-merge (user-gated): repo public flip → GHCR visibility → `gh release create v0.1.0`
  (triggers the workflow once trusted publishing is configured) or local `npm publish`.
