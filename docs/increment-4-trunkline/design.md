# Increment 4 — rename agentphone → trunkline

## What & why

The name `agentphone` collides on npm (taken, v1.0.16) and semantically with multiple
agent-SMS/telephony projects (people will assume real telephony). The project is about to go
public and publish to npm, so this is the last cheap moment to rename. Chosen name:
**trunkline** — a trunk line is the telephone circuit connecting two exchanges, which is
precisely what this server is between machines. npm unscoped `trunkline` is available; no
meaningful GitHub collision (checked 2026-07-15).

## Scope — what gets the new name

| Surface | Old | New |
|---|---|---|
| npm package / bin / dist | `agentphone` / `dist/agentphone.js` | `trunkline` / `dist/trunkline.js` |
| CLI program + printed hints | `agentphone …` | `trunkline …` |
| Env vars | `AGENTPHONE_{URL,TOKEN,PORT,BIND,DB,EVENTS,THREAD_TTL_HOURS}` | `TRUNKLINE_*` (clean break, no fallback aliases) |
| Token / invite prefixes (new mints only) | `ap_` / `ap-invite-` | `tl_` / `tl-invite-` |
| Default file paths | `./agentphone.db`, `./agentphone.events.jsonl` | `./trunkline.db`, `./trunkline.events.jsonl` |
| MCP server name | `agentphone` | `trunkline` |
| Docker image / container / volume / compose service | `ghcr.io/omnith/agentphone`, `agentphone`, `agentphone-data` | `ghcr.io/omnith/trunkline`, `trunkline`, `trunkline-data` |
| README / overview / banner | agentphone | trunkline (banner wordmark regenerated, phone glyph kept) |
| GitHub repo (post-merge step) | `Omnith/agentphone` | `Omnith/trunkline` (auto-redirects) |

Port stays 4747. HTTP API routes (`/api/*`, `/mcp`) unchanged — the wire contract is
name-free, so **old clients keep working against the new server** (volumi can migrate
lazily; its stored token remains valid because auth is by hash and prefixes are cosmetic).

## Non-goals / explicitly unchanged

- Historical docs (`docs/increment-1..3-*`, `docs/investigations/*`) keep "agentphone" — they
  are records, not living docs.
- No HTTP/MCP contract changes; no version bump semantics beyond the name.
- npm publish itself (needs user-side npm account/org) — separate step after this increment.
- Old GHCR `agentphone` package deletion — user-side cleanup, any time.

## Also folded in (process/doc corrections discovered en route)

- `CLAUDE.md` merge policy: repo now enforces linear history (merge commits disabled) —
  prescribe `gh pr merge --rebase` instead of `--merge`; keep "never squash".
- README badge points at a workflow named `Security Check`; the workflow is named `ci` — fix
  the badge URL. `agentphone.omnith.com` links become `trunkline.omnith.com` (site itself is
  user-side).

## Migration of the live deployment

The running container's volume (`agentphone-data`) holds live registrations (desktop,
volumi). Plan: stop old container, copy volume contents to `trunkline-data` via a one-shot
container, `docker compose up -d --build` under the new names, verify health + phonebook
shows both agents, then send volumi a voicemail (over trunkline itself) describing its
lazy client migration. Old container/volume removed only after verification.

## Banner

`assets/banner.svg` = dot-grid phone glyph (kept verbatim) + wordmark in Bitcount Grid
Single converted to paths. The generation script was never committed; rebuild it (fetch font
from google/fonts, render "trunkline", same size/color/baseline), emit PNG previews, and
**gate on user approval** before committing the new SVG.

## Acceptance criteria

- AC1: `git grep -il agentphone` on the branch returns only historical docs
  (`docs/increment-1..3-*`, `docs/investigations/*`) and `docs/increment-4-trunkline/*`.
- AC2: full gates green (build/typecheck/lint/test); `node dist/trunkline.js --help` works;
  fresh register mints a `tl_` token via a `tl-invite-` code.
- AC3: redeployed container healthy under new names with desktop+volumi registrations
  intact; old token still authenticates (hash-based) — proven via a phonebook call with the
  existing desktop token.
- AC4: banner approved by user and rendering in README.
- AC5: repo renamed to `Omnith/trunkline` post-merge; local remote updated; CI green on the
  renamed repo (image pushes as `ghcr.io/omnith/trunkline`).

## Test strategy

A rename is a contract change, not new behavior: existing tests are updated in the same
commit as the code they pin (env names in `config.test.ts`, prefixes in `tokens.test.ts`
etc.) — no red-first cycle applies to a sweep, the gate is the full suite staying green and
the AC1 grep. One genuinely new assertion: none needed (prefix/env values are already
pinned by existing tests; they change with the contract).
