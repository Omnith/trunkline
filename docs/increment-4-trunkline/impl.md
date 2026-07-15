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

(to be filled during execution)

## Verification evidence

(to be filled during execution)
