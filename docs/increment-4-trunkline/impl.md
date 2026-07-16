# Increment 4 — implementation notes

## Plan-review gate (2026-07-15, two parallel Opus reviewers before execution)

Both REVISE; plan rev 2 folds everything in. Highlights:

- **Completeness reviewer:** the AC1 grep was case-insensitive and could NEVER pass
  (`ap_` matches `POLL_CAP_MS`) — now case-sensitive with the constant explicitly protected;
  ci.yml's docker smoke greps `ap-invite-` (would break red with no other gate catching it)
  — added to Task 2 plus a no-push-until-Task-3 rule since `feat/**` pushes trigger CI;
  `docs/overview.md:39` links the historical increment-1 folder (name contains
  "agentphone") — reworded rather than renaming history; the rename map gained six
  overlooked concrete sites (mcp/identity/lifecycle/server tests, commands.test hint regex,
  startup banner string). Verified sound: old `ap_` tokens keep authenticating (hash-only
  auth), pnpm-lock needs no regen, GHCR can publish `trunkline` from the un-renamed repo.
- **Migration-safety reviewer:** compose PREFIXES volume names (`agentphone_agentphone-data`
  is the real live volume) — bare-name copy commands would have silently created empty
  volumes and cut over to a blank phonebook; plan now pins `name:` in compose and verifies
  with `volume ls`/`inspect` before `up`. SQLite runs WAL — renaming the db while carrying
  the old-name `-wal` orphan silently drops committed rows; plan now checkpoints
  (`wal_checkpoint(TRUNCATE)`) in the running container before the graceful stop and asserts
  no `-wal` remains. Also: stop-don't-rm (rollback = `docker start agentphone`), capture the
  desktop token from the MCP registration BEFORE removing it (only plaintext copy), volumi
  voicemail moved after the repo rename (URL exists), README `Omnith/agentphone` URLs
  rewritten preemptively, cutover gated on all gates green.

## Decisions & deviations

- Tasks 1–3 executed by one implementer as three local commits, pushed only after all landed
  (per rev 2's CI-trigger hazard). Two rename sites beyond the plan's list were caught by the
  case-sensitive grep and updated with the contract (`client.test.ts` `ap_wrong`,
  `story.test.ts` mkdtemp prefix + bearer literal).
- Banner regenerated from the Bitcount Grid Single variable font via per-glyph path assembly
  (word-level `font.getPath` produced broken path data under librsvg; per-glyph
  `glyph.getPath` at manual 600-unit advances renders correctly). Calibration recovered the
  original render exactly (size 178, identical bbox to fp precision). User approved previews.
- Migration reality vs plan: the old container had already exited 0 (graceful) 15 hours
  earlier, so the WAL-checkpoint-while-running step was replaced by direct evidence — volume
  listing showed NO `-wal`/`-shm` files — and the copy command encoded both preconditions
  (container not running + no WAL) as hard guards.
- New-volume ownership trap (not in plan): the alpine copy one-shot created `trunkline-data`'s
  root dir as `root`, so uid-1000 node couldn't create SQLite journal files → crash-loop
  ("attempt to write a readonly database"). Fixed with `chown -R 1000:1000` on the volume;
  container recovered on its next restart-policy attempt. Worth remembering for any future
  volume migration.
- Old volume `agentphone_agentphone-data` deliberately KEPT after AC3 (plan permitted
  removal) — zero-cost extra rollback for the data; delete whenever.

## Verification evidence (2026-07-16)

- Tasks 1–3 gates: all green per task (tsup/tsc/eslint/prettier/vitest 76/76); AC1 grep over
  the repo returns exactly the historical docs set; docker build smoke: health 200, one-shot
  invite minted `tl-invite-…`.
- Task 5 cutover: copy verified byte-identical sizes (db 77824, events 22159) into
  `trunkline-data`; `trunkline` container Up (healthy), `/api/health` 200 in 2.9ms;
  `admin list` shows desktop + volumi intact; **AC3: the pre-rename `ap_` desktop token
  returned 200 on `GET /api/agents`** (auth is hash-based; prefixes cosmetic — as designed);
  new mint sanity: `tl-invite-Hle_…`. MCP re-registered at user scope as `trunkline`:
  ✔ Connected.
- Note for the record: the read-latency probe's raw-HTTP rows labeled "phonebook/inbox" had
  hit the JSON 404 catch-all (`/api/phonebook` is not a route; the REST path is
  `/api/agents`) — timing conclusions unaffected (the 404 path measures the same
  express+network stack; CLI/MCP rows measured real verbs end-to-end).
