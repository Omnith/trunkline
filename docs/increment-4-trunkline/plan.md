# Increment 4 — trunkline rename: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans or subagent-driven-development. Implementers MUST invoke `superpowers:test-driven-development` (note: per design.md, a rename sweep updates contract tests in the same commit as the contract — the gate is the full suite + AC greps, not red-first).

**Goal:** Rename agentphone → trunkline everywhere living (design.md scope table), regenerate the banner with approval, migrate the live deployment, then rename the GitHub repo.

**Branch:** `feat/ffl-4-trunkline`

---

> **Plan rev 2 (plan-review gate):** push the branch ONLY after Tasks 1–3 are all committed —
> CI triggers on `feat/**` and the docker smoke greps the invite prefix, so a push between
> tasks is a guaranteed red run. The AC1/AC2 greps below are **case-sensitive** (`-i` would
> false-positive on `POLL_CAP_MS` in `src/cli/commands.ts` — do NOT rename that constant).

### Task 1: source + test sweep

**Files:** ALL of `src/**` and `test/**`. Known sites beyond the map (the grep is the real
gate; this list exists so nothing is "interpreted"): `test/mcp.test.ts:121` (`ap_wrong`),
`src/core/service.identity.test.ts:6,10,48` (comment + `toMatch(/^ap_/)` + `ap_wrong`),
`src/http/server.test.ts:14,18,35,36` (string literals: `agentphone.db` dbPath +
`agentphone-server-`/`agentphone-shutdown-` mkdtemp prefixes — NOT comments),
`src/core/service.lifecycle.test.ts:84` (mkdtemp prefix), `src/cli/commands.test.ts:52`
(`/agentphone call volumi/` pins the hint in `commands.ts:96`), `src/cli/index.ts:175`
(startup banner string `agentphone listening on …`).

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
- [ ] Apply the map. `git grep -n "agentphone\|AGENTPHONE\|ap_\|ap-invite-" src/ test/` (case-sensitive!) must return zero hits afterwards (AC1 for src). `POLL_CAP_MS` stays.
- [ ] Gates: `pnpm run build`, `pnpm run typecheck`, eslint + prettier direct, `vitest run` — all green.
- [ ] Smoke: `TRUNKLINE_DB=<temp> node dist/agentphone.js admin invite --name t` prints `tl-invite-…` (dist name changes in Task 2; at this point entry is still agentphone).
- [ ] Commit: `refactor(core,cli,mcp): rename agentphone -> trunkline in source, env vars, prefixes, defaults`

### Task 2: packaging + docker + ci

**Files:** `package.json`, `tsup.config.ts`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.gitignore` (db/jsonl patterns are wildcarded — verify, adjust only if name-specific).

- [ ] `package.json`: `"name": "trunkline"`, `"bin": { "trunkline": "dist/trunkline.js" }`.
- [ ] `tsup.config.ts`: `entry: { trunkline: 'src/cli/index.ts' }` → emits `dist/trunkline.js`.
- [ ] `Dockerfile`: ENV `TRUNKLINE_BIND=0.0.0.0`, `TRUNKLINE_DB=/data/trunkline.db`, `TRUNKLINE_EVENTS=/data/trunkline.events.jsonl`; HEALTHCHECK + ENTRYPOINT paths → `dist/trunkline.js`.
- [ ] `docker-compose.yml`: image `ghcr.io/omnith/trunkline:latest`, container_name `trunkline`, volume `trunkline-data` **with an explicit `name: trunkline-data`** (compose otherwise prefixes the project dir — `agentphone_agentphone-data` is the ACTUAL current volume name; bare-name copies would silently create empty volumes).
- [ ] `ci.yml`: metadata images `ghcr.io/omnith/trunkline`; smoke commands `docker exec … node dist/trunkline.js …`, container/volume names in the smoke script; **lines 71 and 74: `grep -q "ap-invite-"` → `grep -q "tl-invite-"`** (the smoke would otherwise fail against the new mint prefix — no other gate catches this).
- [ ] Gates + local docker smoke: `docker build -t trunkline:smoke .` then health + one-shot invite prints `tl-invite-…`.
- [ ] Commit: `build(docker,ci): trunkline image, bin, and smoke under the new name`

### Task 3: living docs

**Files:** `README.md`, `docs/overview.md`, `CLAUDE.md`.

- [ ] README: swap every `agentphone` → `trunkline` (commands, env table, MCP add, compose notes, alt text); ALL `github.com/Omnith/agentphone` URLs → `Omnith/trunkline` preemptively (badges/actions/releases — they resolve after Task 6's rename; badge URL form: `actions/workflows/ci.yml/badge.svg`, matching the actual workflow); `agentphone.omnith.com` → `trunkline.omnith.com`; invite/token examples `ap-…` → `tl-…`. Preserve the hand-crafted structure/wording otherwise.
- [ ] `docs/overview.md`: name swap in living references; line 39 links the historical folder `docs/increment-1-agentphone-core/` — reword to drop the embedded folder name (e.g. "Increment 1 — core server, CLI, and MCP surface") so AC1's grep passes without renaming history.
- [ ] `CLAUDE.md`: merge step now `gh pr merge --rebase --delete-branch` (repo enforces linear history; still never squash).
- [ ] AC1 grep: `git grep -il agentphone` → only `docs/increment-1..3-*`, `docs/investigations/*`, `docs/increment-4-trunkline/*`.
- [ ] Commit: `docs: trunkline sweep - readme, overview, badge fix, rebase merge policy`

### Task 4: banner (user approval gate)

- [ ] Scratchpad script: fetch Bitcount Grid Single TTF (github.com/google/fonts, SIL OFL), render "trunkline" to SVG paths at the existing wordmark's size/color/baseline; keep the existing phone dot-glyph group verbatim; recompute viewBox.
- [ ] Render PNG preview(s) (light/dark bg), **send to user, wait for approval**.
- [ ] On approval: replace `assets/banner.svg`, update README alt text if needed. Commit: `docs(assets): trunkline banner - bitcount wordmark, dot-grid phone kept`

### Task 5: live deployment migration

**Gate: Tasks 1–4 committed, full local gates + docker build smoke green, plan-review
findings addressed — the cutover runs reviewed code only (prod precedes PR merge by
necessity; rollback is one `docker start agentphone`).**

- [ ] **Capture the desktop token FIRST**: `claude mcp get agentphone` (check its actual
  scope while there) — the Authorization header is the only plaintext copy; the DB stores
  hashes. Without this, AC3 and the MCP re-registration are stranded.
- [ ] Identify the REAL volume: `docker volume ls` (expected: `agentphone_agentphone-data`
  or similar compose-prefixed name — do not assume).
- [ ] Checkpoint the WAL while the old container still runs:
  `docker exec agentphone node -e "const d=require('better-sqlite3')('/data/agentphone.db');d.pragma('wal_checkpoint(TRUNCATE)');d.close()"`
- [ ] `docker stop agentphone` (graceful since increment 3; do NOT `rm` — it is the rollback).
- [ ] Copy + rename into the exact volume compose will mount (explicit `name:` from Task 2):
  `docker run --rm -v <real-old-volume>:/from -v trunkline-data:/to alpine sh -c "cp /from/agentphone.db /to/trunkline.db && cp /from/agentphone.events.jsonl /to/trunkline.events.jsonl && ls -la /from /to"`
  — copy ONLY these two (no blanket `cp -a`); assert no `agentphone.db-wal` remains in
  `/from` after the checkpoint+graceful stop (if one exists, STOP and re-checkpoint; never
  carry a `-wal` under a renamed db).
- [ ] `docker volume inspect trunkline-data` + the `ls` output above confirm non-empty BEFORE `up`.
- [ ] `docker compose up -d --build`; health 200; `docker exec trunkline node dist/trunkline.js admin list` shows desktop + volumi.
- [ ] AC3 proof: phonebook call with the captured desktop token (old `ap_…` value) succeeds.
- [ ] Update this machine's MCP registration: remove `agentphone` at its ACTUAL scope, add
  `trunkline` (same URL/token). Rollback if anything fails: `docker start agentphone` (old
  container + old volume are untouched).
- [ ] Remove old container/image tag/volume only after AC3 verified. (Volumi's parked ring,
  if any, will exit 1 on the restart — its loop guidance says back off and re-listen; note
  the downtime window in the voicemail.)
- [ ] Record evidence in `impl.md`. (The volumi migration voicemail moves to Task 6 — after
  the repo rename — so the URL it references exists.)

### Task 6: PR + repo rename (post-merge)

- [ ] `impl.md` (decisions, evidence), push, `gh pr create`, CI green, `gh pr merge --rebase --delete-branch`.
- [ ] `gh api -X PATCH repos/Omnith/agentphone -f name=trunkline`; `git remote set-url origin https://github.com/Omnith/trunkline.git`; verify `gh repo view Omnith/trunkline` + a main-push CI run publishes `ghcr.io/omnith/trunkline`.
- [ ] NOW send volumi the migration voicemail over trunkline (from desktop identity): new
  repo URL (live, post-rename), env var renames (`AGENTPHONE_*` → `TRUNKLINE_*`), new bin
  name, "old clone + old env keep working — HTTP contract unchanged; migrate at leisure",
  and the downtime window during which any parked listen exited 1.
- [ ] Note for user: old GHCR `agentphone` package can be deleted whenever; npm publish is
  the next step and needs the npm account/org (package.json keeps `private: true` and no
  `repository` field until that step — deliberate).
