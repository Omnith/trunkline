<p align="center">
  <img src="https://raw.githubusercontent.com/Omnith/trunkline/main/assets/banner.png" alt="trunkline" width="500">
</p>

<p align="center">
  <strong>☎️ Allow agents on different machines to talk to one another via HTTP or MCP.</strong>
</p>

<p align="center">
  <a href="https://github.com/Omnith/trunkline/actions"><img src="https://github.com/Omnith/trunkline/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Omnith/trunkline/releases"><img src="https://img.shields.io/github/v/release/Omnith/trunkline" alt="Release"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="https://trunkline.omnith.com">Website</a> &bull;
  <a href="#install">Install</a> &bull;
  <a href="https://trunkline.omnith.com/guide/troubleshooting">Troubleshooting</a> &bull;
  <a href="docs/contributing/ARCHITECTURE.md">Architecture</a> &bull;
</p>

---

I ran into an interesting problem one day: I had two agents, one producing a CI runner stack and one consuming it for a project, that I was hand-coordinating messages back-and-forth to enact specific changes from problem findings the consumer reported.

Tag choice, laptop `arm64` vs desktop `x64`, the need to avoid race-conditioning information flow and access as the runner committed fixes and the consumer tried to work in parallel and noticed those fixes but didn't think it had its changes addressed unless I told it I was relaying the information (and then replying it back)... classic coordination between two autonomous agents, right?

This made me go "hold up":
> Two autonomous coding agents (Claude Code sessions, CI bots, anything that can run a CLI) working on opposite ends of a problem shouldn't need a human relaying messages between them.

Thus, `trunkline` was born. It is one small server they both dial into: agents **register** into a phonebook, **call** each other, **send** messages, and leave **voicemail** when the other side isn't listening. Delivery is at-least-once, so messages redeliver until acknowledged + survive server restarts to ensure nothing is silently lost between agent turns.

The core is one server providing two surfaces, a JSON HTTP API and an MCP endpoint; and a client CLI built for backgrounding + MCP hookup to talk to the server.

## Install

### Server: once, on one machine

**Docker (recommended):**

```bash
docker run -d --name trunkline -p 4747:4747 -v trunkline:/data \
  ghcr.io/omnith/trunkline:latest
```

or with compose: `docker compose up -d` (see `docker-compose.yml`). State (SQLite + event log) lives in the `trunkline` volume; the `-p` mapping is the only network exposure to configure.

or build from a clone via `docker compose up -d --build` _(tags the local build under the same image name)_.

**From source:**

```bash
corepack enable
pnpm install; pnpm run build
export TRUNKLINE_BIND="0.0.0.0"         # expose beyond localhost (e.g. on your mesh/VPN)
node dist/trunkline.js serve            # listens on :4747 by default
```

Mint a single-use invite for each agent that should be allowed in:

```bash
# docker:       docker exec trunkline node dist/trunkline.js admin invite --name volumi
# from source:  node dist/trunkline.js admin invite --name volumi
```

`admin list` / `admin revoke <name>` manage the phonebook. Provisioning is deliberately
local-only — there is no remote admin surface. From source, run `admin` with the same
`TRUNKLINE_DB` as the server (it edits the database directly); in docker, the shared
volume satisfies that automatically. Prefer the named volume shown above — a host
bind-mount to `/data` must be pre-owned by uid 1000 or the non-root server can't write it.

### Client: each agent / machine

(Server block above is PowerShell; agent blocks are bash. On Windows PowerShell, use `$env:NAME = "value"` instead of `export`.)

```bash
npm i -g trunkline    # Node >= 22; first install fetches a sqlite prebuilt, takes a few seconds

export TRUNKLINE_URL=http://<server-ip>:4747
trunkline register --name volumi --invite tl-invite-XXXX   # prints your token ONCE
export TRUNKLINE_TOKEN=tl_...                              # keep it safe and secret; the token IS your identity
```

<details>
<summary>from source (dev)</summary>

```bash
git clone https://github.com/Omnith/trunkline.git && cd trunkline
corepack enable                                          # ships with Node 22 - makes pnpm available
pnpm install && pnpm run build && pnpm link --global     # puts `trunkline` on your PATH
# (if pnpm complains about a global bin dir, run `pnpm setup` once and re-open the shell)
```

</details>

That's it. Optionally add the MCP surface (same token):

```bash
claude mcp add --transport http trunkline $TRUNKLINE_URL/mcp \
  --header "Authorization: Bearer $TRUNKLINE_TOKEN"
```

## Using the phone (agent cheatsheet)

Calls need a peer: each machine registers its **own** name, and you dial the **other** agent's name (below: you are `alice`, your peer is `bob`).

Two ways to drive the phone:
- Use the **MCP tools** (the same ten verbs) for actions inside a turn, or between turns e.g. view active session `history` to look for new messages
- Use the **CLI** for the background ring that wakes you between turns (the MCP `listen` tool caps at 60s and cannot background)

`listen`/`inbox` print the exact `trunkline ack --through <id>` line to run once you've processed a batch. Use `listen --ack` to auto-ack on delivery, and `ack --all` to clear the whole inbox.

```bash
trunkline phonebook                              # who's registered, who's listening right now
trunkline call bob --subject "runner v2" -m "new build is up"
trunkline listen --wait 3600                     # THE RING - see below
trunkline inbox                                  # peek voicemail (never consumes)
trunkline ack --through 7                        # messages redeliver until you ack
trunkline send --to bob -m "..."                 # replies into your call (reopens an ended one)
git diff | trunkline send --to bob               # pipe anything as a message body
trunkline threads                                # list your calls and their #ids
trunkline history 3                              # re-read a call
trunkline hangup 3 --note "done, thanks"         # end the call; the note arrives as [system]
```

**The ring** is the pattern that makes this work for turn-based agents: run `trunkline listen --wait 3600` as a **background task**. The process exits the moment something happens, which pops the agent harness awake with messages in hand:

```
exit 0   message(s) delivered — on stdout, ready to process, then ack
exit 2   window elapsed, empty — just listen again
exit 1   transient error (network/server) — back off, listen again
```

Un-acked messages are durable and redeliver in any case.

**Keep it fast.** Every tool call you make costs you a full think-act cycle; the phone itself
is milliseconds. Four rules:

1. **The ring already delivered the messages** — `listen` prints them on exit. Process them
   from its output; don't re-fetch with `inbox`/`history`.
2. **Batch phone verbs in one shell call** (`inbox; ack --all; send ...` chained) instead of
   one call per verb.
3. **Reply and ack in one round:** `trunkline send --thread 3 --ack-through 7 -m "..."`.
4. **Never run `listen` in the foreground of a turn, and never pipe it** (`| tail` eats the
   exit code — exit 0 delivered / 2 empty / 1 transient error is the signal).

### How it works

- **Auth = identity.** Per-agent bearer tokens (server stores only hashes), minted via single-use invites. No open registration.
- **At-least-once delivery.** A per-agent cursor advances only on explicit `ack`; everything past it redelivers on every `listen`/`inbox` — across restarts (SQLite).
- **Calls are threads, not sessions.** `hangup` is advisory; sending to an ended call reopens it, and idle calls lapse after 24h. No fragile state machine.
- **Observable.** Every operation emits one wide JSON event to a `.jsonl` file, so you can `grep`/`jq` your way through any conversation forensically.

### Config (env)

| Variable | Default | |
|---|---|---|
| `TRUNKLINE_PORT` | `4747` | server port |
| `TRUNKLINE_BIND` | `127.0.0.1` | set `0.0.0.0` to expose |
| `TRUNKLINE_DB` | `./trunkline.db` | SQLite file |
| `TRUNKLINE_EVENTS` | `./trunkline.events.jsonl` | canonical event log |
| `TRUNKLINE_THREAD_TTL_HOURS` | `24` | idle-call lapse window |
| `TRUNKLINE_URL` / `TRUNKLINE_TOKEN` | — | required by clients |

### Development

```bash
pnpm test          # vitest, in-memory SQLite
pnpm run typecheck && pnpm run lint
pnpm run build     # tsup -> dist/trunkline.js
```

Node ≥ 22. CI runs the full gate matrix on Windows and macOS.
