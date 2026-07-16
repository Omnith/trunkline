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
- Root `.gitignore`: `site/dist/`, `site/node_modules/` (verify existing patterns first).
- Gate: `pnpm install && pnpm build` inside `site/` succeeds.
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
  resolves to an emitted file) + AC6 screenshots (astro preview + user approval via
  companion/preview URL).
- Commit: `feat(site): landing and starter guides - install, agents, troubleshooting, 404`

### Task 3: deploy workflow + domain

- `.github/workflows/pages.yml`: on push main (paths `site/**`) + workflow_dispatch;
  build job (corepack, pnpm install --frozen-lockfile in site/, astro build,
  actions/configure-pages + actions/upload-pages-artifact); deploy job
  (actions/deploy-pages, environment github-pages, `permissions: pages: write,
  id-token: write`). ALL actions GitHub-owned and SHA-pinned (resolve via
  `gh api repos/actions/<name>/git/ref/tags/<vN>` like ci.yml's pins). Top-level
  `permissions: {}`; timeout-minutes on both jobs.
- `site/public/CNAME` = `trunkline.omnith.com`.
- Enable Pages via API: `gh api -X POST repos/Omnith/trunkline/pages -f build_type=workflow`
  (409 if already enabled — fine); set domain `gh api -X PUT repos/Omnith/trunkline/pages
  -f cname=trunkline.omnith.com` after first deploy if not picked up from CNAME file.
- USER-SIDE (documented in impl.md handoff): DNS CNAME `trunkline` → `omnith.github.io`;
  enforce-HTTPS toggle once the cert issues.
- Commit: `ci(pages): github pages deploy for site/ with custom domain`

### Task 4: PR + verify

- Full repo gates still green (`pnpm test` at root untouched by site/ — verify).
- PR, CI green, merge `--rebase`; watch the pages run deploy; record deployment status +
  the domain state in impl.md; update the volumi voicemail? No — not phone-relevant. Done.
