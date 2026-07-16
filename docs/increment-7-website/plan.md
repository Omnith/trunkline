# Increment 7 — website: implementation plan

> Static-site increment. Implementation runs INLINE in the orchestrating session (deviation
> from the subagent-default, recorded here: the aesthetic was negotiated live with the user
> through the brainstorm companion and the feedback loop stays tighter without a relay).
> Plan-gate: one reviewer focused on the Pages workflow + repo/packaging interactions.
> Branch `feat/ffl-7-website`.

### Task 1: scaffold `site/`

- `site/package.json` (private, own lockfile; deps: astro, @fontsource/space-grotesk,
  @fontsource/ibm-plex-sans, @fontsource/ibm-plex-mono; scripts dev/build/preview).
- `astro.config.mjs`: `site: 'https://trunkline.omnith.com'`, static output (default).
- `src/layouts/Base.astro`: fonts imported, CSS custom-property token system (both themes
  from design.md verbatim), inline pre-paint theme script (localStorage → system pref →
  dark), nav (brand, Docs, GitHub, npm, version, toggle), footer. Toggle = the switchboard
  jack from the approved mockup.
- `src/styles/global.css`: tokens, base type scale (Space Grotesk headings / Plex Sans
  body / Plex Mono code), plate/eyebrow component, code-block styling, focus-visible rings,
  reduced-motion guard.
- **Isolation set (plan-gate rev 2, blocking):** `eslint.config.js` ignores gains `'site/**'`
  (flat-config patterns are anchored — root `eslint .` would otherwise lint site sources
  under strict rules); `.prettierignore` gains `site/` (root prettier must not govern site
  formatting); `.dockerignore` gains `site` (dockerignore patterns are root-anchored —
  `site/node_modules` would otherwise ship to the daemon and churn the `COPY . .` cache).
  Root `.gitignore` needs NO new lines (existing any-level `dist/`/`node_modules/` cover
  site's — verified by the gate reviewer). `site/package.json` omits `packageManager`
  (corepack walks up to the root pin; lockfile generated with pnpm 10.34.5).
- Gate: `pnpm install && pnpm build` inside `site/` succeeds; root `npx eslint .` and
  `npx prettier --check .` stay clean with site/ present.
- Commit: `feat(site): astro scaffold - night-switchboard token system, themed layout`

### Task 2: pages

- `/` landing per design.md IA — hero with the patch-cord SVG signature (taken from the
  approved mockup, refined), plain-tone copy, real commands only.
- `/guide/install/`, `/guide/agents/`, `/guide/troubleshooting/`, `404.astro`.
- Content is REWRITTEN from README + docs/overview.md + src (exit codes from
  cli/commands.ts, env vars from core/config.ts, verbs from mcp/tools.ts descriptions) —
  every command cross-checked against the published 0.1.0 behavior (AC3). No invented
  flags, no marketing filler.
- Gate: build + link check (`node` script over `site/dist` asserting every internal href
  resolves to an emitted file) + **external-origin grep** (no `http(s)://` origins in emitted
  html/css beyond trunkline.omnith.com/github/npm links — fonts must be self-hosted; AC1)
  + AC6 screenshots incl. a mobile-viewport shot (astro preview + user approval).
- Commit: `feat(site): landing and starter guides - install, agents, troubleshooting, 404`

### Task 3: deploy workflow + domain

- `.github/workflows/pages.yml`: on push main (paths `site/**` AND
  `.github/workflows/pages.yml` itself) + workflow_dispatch;
  `concurrency: { group: pages, cancel-in-progress: false }` (let in-flight Pages deploys
  finish — GitHub's own template default); build job (`permissions: contents: read`,
  corepack, pnpm install --frozen-lockfile in site/, astro build,
  actions/upload-pages-artifact — NO configure-pages: Astro's `site:` + base `/` make it
  redundant and it would need pages scope); deploy job (actions/deploy-pages, environment
  github-pages with `url: ${{ steps.deployment.outputs.page_url }}`, `permissions:
  pages: write, id-token: write`). ALL actions GitHub-owned and SHA-pinned (resolve via
  `gh api repos/actions/<name>/git/ref/tags/<vN>` like ci.yml's pins). Top-level
  `permissions: {}`; timeout-minutes on both jobs.
- `site/public/CNAME` = `trunkline.omnith.com`.
- Enable Pages via API: `gh api -X POST repos/Omnith/trunkline/pages -f build_type=workflow`
  (409 if already enabled — fine); set domain `gh api -X PUT repos/Omnith/trunkline/pages
  -f cname=trunkline.omnith.com` after first deploy if not picked up from CNAME file.
- USER-SIDE (documented in impl.md handoff): DNS CNAME `trunkline` → `omnith.github.io`;
  enforce-HTTPS toggle once the cert issues.
- Commit: `ci(pages): github pages deploy for site/ with custom domain`

### Task 4: holistic review + PR + verify

- FULL root gates with site/ present: `pnpm run build && pnpm run typecheck && pnpm run
  lint && pnpm test` — lint is the one site/ could regress (plan-gate H2); confirm clean.
- **Post-build holistic review (dispatched subagent — the checkpoint replacing the skipped
  per-task reviews, plan-gate M6):** scope = (a) AC3 content accuracy: every command,
  env var, exit code on the site cross-checked against cli/commands.ts, core/config.ts,
  mcp/tools.ts as published in 0.1.0; (b) AC1 external-origin grep re-run; (c) pages.yml:
  pins resolve to GitHub-owned refs, least-privilege, concurrency present; (d) isolation
  checks (root lint/docker context/npm tarball unaffected). Fix HIGH/MEDIUM before PR.
- PR, CI green, merge `--rebase`; watch the pages run deploy; record deployment id +
  page_url in impl.md; user-side DNS handoff. Done.
