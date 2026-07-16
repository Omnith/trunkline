# Increment 7 — trunkline.omnith.com (Astro site on GitHub Pages)

## What & why

Public launch needs a home. The README already links `trunkline.omnith.com` (site) and
`trunkline.omnith.com/guide/troubleshooting` (docs) — both currently dead. This increment
ships an Astro static site on GitHub Pages at the custom domain, with a landing page and
starter docs, in the visual direction chosen through the brainstorm companion (2026-07-16).

## Locked design direction (user-selected, mockups in `.superpowers/brainstorm/`)

- **Aesthetic:** "Bell-era switchboard, after dark" — the warm-tungsten dark variant is the
  DEFAULT; the cream/exchange-blue light variant remains available via a working nav toggle
  (system preference respected on first visit; choice persisted in localStorage).
- **Type (pairing D):** Space Grotesk (headings/display), IBM Plex Sans (body),
  IBM Plex Mono (code). Self-hosted via @fontsource packages — no third-party font CDN.
- **Palette tokens** (from the approved mockups):
  - dark: bg radial `#262019 → #1a1510 → #140f0b`, panel `#211a13`, ink `#f0e5cf`,
    ink-soft `#b9a888`, head `#f6ead2`, accent copper `#e0834a`, brass `#caa969`,
    line `#3a2f22`, nav `#232d3b`, code-bg `#14100b`, copper bloom shadows.
  - light: bg `#f3ede1`, ink `#21304f`, head/nav `#1d3557`, accent `#c1592f`,
    brass `#8a7c5f`, line `#d8cdb4`, code-bg `#fbf7ee`.
- **Signature element (the one bold thing):** the glowing patch-cord SVG — a copper cord
  connecting two jacks, drawn across the hero; it dims/warms with the theme. Everything else
  stays quiet and disciplined.
- **Copy tone:** plain and factual; no marketing filler. Source material: README +
  docs/overview.md, rewritten for the page, not pasted.
- Structural devices carry meaning: engraved label plates ("Night Exchange · Line 4747")
  used as section eyebrows; exit-code table styled as a switchboard legend.

## Information architecture

```
/                      landing: hero (pitch + npm install), how it works (ring/voicemail/
                       at-least-once), install (server docker + agent npm), cheatsheet
                       strip, footer (GitHub, npm, MIT)
/guide/install/        server (docker, compose, from source) + agent (npm, register, MCP add)
/guide/agents/         using the phone as an agent: the ring, keep-it-fast rules, verbs
                       reference (CLI + MCP incl. snapshot/send.to/ackThrough), invites/tokens
/guide/troubleshooting/ the README-linked page: connection checks, exit codes, firewall/
                       binding, token/invite pitfalls, server events (jsonl) forensics
404                    styled "line disconnected" page
```

## Technical shape

- **Astro** (static output, zero client JS except the ~20-line inline theme toggle),
  content in `.astro` pages + one shared layout; no UI framework.
- Lives in **`site/`** with its own `package.json` + lockfile (NOT a pnpm workspace — the
  root npm package and its `files: ["dist"]` whitelist stay untouched; `site/` is never
  published to npm).
- **Deploy:** `.github/workflows/pages.yml` — on push to main with `site/**` changes +
  `workflow_dispatch`; build with pnpm (corepack), upload via GitHub-owned Pages actions
  (SHA-pinned, org policy compliant); deploy job `permissions: pages: write, id-token: write`.
- **Custom domain:** `site/public/CNAME` = `trunkline.omnith.com`; Pages enabled via API
  (build_type workflow) + domain set via API where token permits. **User-side:** DNS CNAME
  record `trunkline → omnith.github.io` at the omnith.com DNS host; HTTPS enforcement click
  once the cert issues.
- Site URL config: `site: 'https://trunkline.omnith.com'` in astro config (canonical URLs,
  sitemap).

## Acceptance criteria

- AC1: `pnpm build` in `site/` produces a static build with all four routes + 404; no
  external network requests in the built HTML (fonts self-hosted, no CDN links).
- AC2: theme: dark by default (no-preference), light via toggle AND via
  `prefers-color-scheme: light` on first visit; persisted; no flash-of-wrong-theme
  (inline script sets the class before paint).
- AC3: content accuracy: every command shown works against trunkline 0.1.0 as published
  (npm install line, docker line, register/listen/send examples, exit codes, env vars —
  cross-checked against README/source, not invented).
- AC4: Pages workflow deploys on merge; `https://trunkline.omnith.com` serves the site once
  the user's DNS record exists (until then, the `omnith.github.io/trunkline`-style default
  URL is NOT expected to work with a CNAME file present — verification is via the Pages
  deployment status + the custom domain after DNS).
- AC5: quality floor: responsive to mobile, visible keyboard focus, `prefers-reduced-motion`
  respected (the cord glow is static, no animation dependencies), lighthouse-reasonable
  (no render-blocking font CDN, images optimized).
- AC6: screenshots of landing + one guide page (dark + light) rendered and sent for user
  approval before the PR merges.

## Test strategy

Static site: no unit surface. Verification = build success, a link-check pass over the
built output (internal hrefs resolve), the AC3 command cross-check against the repo, and
AC6 visual approval. The Pages workflow is config — reviewed, SHA-pinned, then proven by
the first deploy.
