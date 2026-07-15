# Increment 4 — trunkline rename: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans or subagent-driven-development. Implementers MUST invoke `superpowers:test-driven-development` (note: per design.md, a rename sweep updates contract tests in the same commit as the contract — the gate is the full suite + AC greps, not red-first).

**Goal:** Rename agentphone → trunkline everywhere living (design.md scope table), regenerate the banner with approval, migrate the live deployment, then rename the GitHub repo.

**Branch:** `feat/ffl-4-trunkline`

---

### Task 1: source + test sweep

**Files:** `src/**` (code + tests), `test/story.test.ts`.

The mechanical map (apply case-sensitively, in this order):

| Old | New | Where |
|---|---|---|
| `AGENTPHONE_` | `TRUNKLINE_` | config.ts loaders + error messages, cli/index.ts (adminStore env, register hint, token hint), config.test.ts, server.test.ts temp cfg comments |
| `'ap_'` | `'tl_'` | core/tokens.ts `newToken` |
| `'ap-invite-'` | `'tl-invite-'` | core/tokens.ts `newInviteCode` |
| `ap_` / `ap-invite-` in assertions | `tl_` / `tl-invite-` | tokens.test.ts, provisioning.test.ts, any client/cli tests matching prefixes |
| `./agentphone.db` / `agentphone.events.jsonl` | `./trunkline.db` / `trunkline.events.jsonl` | config.ts defaults + cli adminStore default, config.test.ts |
| `new Command('agentphone')` | `new Command('trunkline')` | cli/index.ts |
| printed `agentphone <verb>` hints | `trunkline <verb>` | cli/index.ts inbox hint, cli/commands.ts listen hint(s) |
| `name: 'agentphone'` (MCP) | `name: 'trunkline'` | mcp/tools.ts buildMcpServer |
| `agentphone CLI` / `agentphone listen` in MCP descriptions | `trunkline …` | mcp/tools.ts listen description |
| `'phonebook, calls, and voicemail for coding agents'` | unchanged (description is name-free) | — |

Steps:
- [ ] Apply the map. `git grep -in "agentphone\|AGENTPHONE\|ap_\|ap-invite" src/ test/` must return zero hits afterwards (AC1 for src).
- [ ] Gates: `pnpm run build`, `pnpm run typecheck`, eslint + prettier direct, `vitest run` — all green.
- [ ] Smoke: `TRUNKLINE_DB=<temp> node dist/agentphone.js admin invite --name t` prints `tl-invite-…` (dist name changes in Task 2; at this point entry is still agentphone).
- [ ] Commit: `refactor(core,cli,mcp): rename agentphone -> trunkline in source, env vars, prefixes, defaults`

### Task 2: packaging + docker + ci

**Files:** `package.json`, `tsup.config.ts`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.gitignore` (db/jsonl patterns are wildcarded — verify, adjust only if name-specific).

- [ ] `package.json`: `"name": "trunkline"`, `"bin": { "trunkline": "dist/trunkline.js" }`.
- [ ] `tsup.config.ts`: `entry: { trunkline: 'src/cli/index.ts' }` → emits `dist/trunkline.js`.
- [ ] `Dockerfile`: ENV `TRUNKLINE_BIND=0.0.0.0`, `TRUNKLINE_DB=/data/trunkline.db`, `TRUNKLINE_EVENTS=/data/trunkline.events.jsonl`; HEALTHCHECK + ENTRYPOINT paths → `dist/trunkline.js`.
- [ ] `docker-compose.yml`: image `ghcr.io/omnith/trunkline:latest`, container_name `trunkline`, volume `trunkline-data`.
- [ ] `ci.yml`: metadata images `ghcr.io/omnith/trunkline`; smoke commands `docker exec … node dist/trunkline.js …`, container/volume names in the smoke script.
- [ ] Gates + local docker smoke: `docker build -t trunkline:smoke .` then health + one-shot invite prints `tl-invite-…`.
- [ ] Commit: `build(docker,ci): trunkline image, bin, and smoke under the new name`

### Task 3: living docs

**Files:** `README.md`, `docs/overview.md`, `CLAUDE.md`.

- [ ] README: swap every `agentphone` → `trunkline` (commands, env table, MCP add, compose notes, alt text); badge URL workflow `Security%20Check` → `ci`; `agentphone.omnith.com` → `trunkline.omnith.com`; invite/token examples `ap-…` → `tl-…`. Preserve the hand-crafted structure/wording otherwise.
- [ ] `docs/overview.md`: name swap in living references.
- [ ] `CLAUDE.md`: merge step now `gh pr merge --rebase --delete-branch` (repo enforces linear history; still never squash).
- [ ] AC1 grep: `git grep -il agentphone` → only `docs/increment-1..3-*`, `docs/investigations/*`, `docs/increment-4-trunkline/*`.
- [ ] Commit: `docs: trunkline sweep - readme, overview, badge fix, rebase merge policy`

### Task 4: banner (user approval gate)

- [ ] Scratchpad script: fetch Bitcount Grid Single TTF (github.com/google/fonts, SIL OFL), render "trunkline" to SVG paths at the existing wordmark's size/color/baseline; keep the existing phone dot-glyph group verbatim; recompute viewBox.
- [ ] Render PNG preview(s) (light/dark bg), **send to user, wait for approval**.
- [ ] On approval: replace `assets/banner.svg`, update README alt text if needed. Commit: `docs(assets): trunkline banner - bitcount wordmark, dot-grid phone kept`

### Task 5: live deployment migration

- [ ] `docker compose down` (old file already replaced — use explicit `docker stop agentphone && docker rm agentphone` since compose names changed).
- [ ] Copy volume: `docker run --rm -v agentphone-data:/from -v trunkline-data:/to alpine sh -c "cp -a /from/. /to/"` — note file names inside the volume stay `agentphone.db`/`agentphone.events.jsonl` from the old ENV; the new container's ENV points at `trunkline.db` — so ALSO rename during copy: `cp /from/agentphone.db /to/trunkline.db; cp /from/agentphone.events.jsonl /to/trunkline.events.jsonl` (keep WAL/SHM siblings if present).
- [ ] `docker compose up -d --build`; health 200; `docker exec trunkline node dist/trunkline.js admin list` shows desktop + volumi.
- [ ] AC3 proof: phonebook call with the existing desktop token (old `ap_…` value) succeeds.
- [ ] Update this machine's MCP registration: `claude mcp remove agentphone`, `claude mcp add --scope user --transport http trunkline http://100.110.150.142:4747/mcp --header "Authorization: Bearer <desktop token>"`.
- [ ] Send volumi a voicemail over trunkline (from desktop identity) with its lazy migration note (new repo URL post-rename, env var names, no urgency — old client keeps working).
- [ ] Remove old container/image tag/volume only after AC3 verified.
- [ ] Record evidence in `impl.md`.

### Task 6: PR + repo rename (post-merge)

- [ ] `impl.md` (decisions, evidence), push, `gh pr create`, CI green, `gh pr merge --rebase --delete-branch`.
- [ ] `gh api -X PATCH repos/Omnith/agentphone -f name=trunkline`; `git remote set-url origin https://github.com/Omnith/trunkline.git`; verify `gh repo view Omnith/trunkline` + a main-push CI run publishes `ghcr.io/omnith/trunkline`.
- [ ] Note for user: old GHCR `agentphone` package can be deleted whenever; npm publish is the next step and needs the npm account/org.
