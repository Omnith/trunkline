<p align="center">
  <img src="assets/banner.svg" alt="agentphone" width="500">
</p>

<p align="center">
  <strong>☎️ Allow agents on different machines to talk to one another via HTTP or MCP.</strong>
</p>

<p align="center">
  <a href="https://github.com/Omnith/agentphone/actions"><img src="https://github.com/Omnith/agentphone/workflows/Security%20Check/badge.svg" alt="CI"></a>
  <a href="https://github.com/Omnith/agentphone/releases"><img src="https://img.shields.io/github/v/release/Omnith/agentphone" alt="Release"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="https://agentphone.omnith.com">Website</a> &bull;
  <a href="#install">Install</a> &bull;
  <a href="https://agentphone.omnith.com/guide/troubleshooting">Troubleshooting</a> &bull;
  <a href="docs/contributing/ARCHITECTURE.md">Architecture</a> &bull;
</p>

---

I ran into an interesting problem one day: I had two agents, one producing a CI runner stack and one consuming it for a project, that I was hand-coordinating messages back-and-forth to enact specific changes from problem findings the consumer reported.

Tag choice, laptop `arm64` vs desktop `x64`, the need to avoid race-conditioning information flow and access as the runner committed fixes and the consumer tried to work in parallel and noticed those fixes but didn't think it had its changes addressed unless I told it I was relaying the information (and then replying it back)... classic coordination between two autonomous agents, right?

This made me go "hold up":
> Two autonomous coding agents (Claude Code sessions, CI bots, anything that can run a CLI) working on opposite ends of a problem shouldn't need a human relaying messages between them.

Thus, `agentphone` was born. It is one small server they both dial into: agents **register** into a phonebook, **call** each other, **send** messages, and leave **voicemail** when the other side isn't listening. Delivery is at-least-once, so messages redeliver until acknowledged + survive server restarts to ensure nothing is silently lost between agent turns.

The core is one server providing two surfaces, a JSON HTTP API and an MCP endpoint; and a client CLI built for backgrounding + MCP hookup to talk to the server.

## Install

### Server: once, on one machine

**Docker (recommended):**

```bash
docker run -d --name agentphone -p 4747:4747 -v agentphone:/data \
  ghcr.io/omnith/agentphone:latest
```

or with compose: `docker compose up -d` (see `docker-compose.yml`). State (SQLite + event log) lives in the `agentphone` volume; the `-p` mapping is the only network exposure to configure.

> **Private registry note:** the GHCR image is currently private. Either build from a clone via `docker compose up -d --build` _(tags the local build under the same image name)_, or do a one-time `docker login ghcr.io` with a PAT that has `read:packages` and pull as shown.

**From source:**

```bash
corepack enable
pnpm install; pnpm run build
export AGENTPHONE_BIND = "0.0.0.0"       # expose beyond localhost (e.g. on your mesh/VPN)
node dist/agentphone.js serve            # listens on :4747 by default
```

Mint a single-use invite for each agent that should be allowed in:

```bash
# docker:       docker exec agentphone node dist/agentphone.js admin invite --name volumi
# from source:  node dist/agentphone.js admin invite --name volumi
```

`admin list` / `admin revoke <name>` manage the phonebook. Provisioning is deliberately
local-only — there is no remote admin surface. From source, run `admin` with the same
`AGENTPHONE_DB` as the server (it edits the database directly); in docker, the shared
volume satisfies that automatically. Prefer the named volume shown above — a host
bind-mount to `/data` must be pre-owned by uid 1000 or the non-root server can't write it.

### Client: each agent / machine

(Server block above is PowerShell; agent blocks are bash. On Windows PowerShell, use `$env:NAME = "value"` instead of `export`.)

```bash
git clone <repo-url> agentphone && cd agentphone
corepack enable                                          # ships with Node 22 - makes pnpm available
pnpm install && pnpm run build && pnpm link --global     # puts `agentphone` on your PATH
# (if pnpm complains about a global bin dir, run `pnpm setup` once and re-open the shell)

export AGENTPHONE_URL=http://<server-ip>:4747
agentphone register --name volumi --invite ap-invite-XXXX   # prints your token ONCE
export AGENTPHONE_TOKEN=ap_...                              # keep it safe and secret; the token IS your identity
```

That's it. Optionally add the MCP surface (same token):

```bash
claude mcp add --transport http agentphone $AGENTPHONE_URL/mcp \
  --header "Authorization: Bearer $AGENTPHONE_TOKEN"
```

## Using the phone (agent cheatsheet)

Calls need a peer: each machine registers its **own** name, and you dial the **other** agent's name (below: you are `alice`, your peer is `bob`).

Two ways to drive the phone:
- Use the **MCP tools** (the same ten verbs) for actions inside a turn, or between turns e.g. view active session `history` to look for new messages
- Use the **CLI** for the background ring that wakes you between turns (the MCP `listen` tool caps at 60s and cannot background)

`listen`/`inbox` print the exact `agentphone ack --through <id>` line to run once you've processed a batch. Use `listen --ack` to auto-ack on delivery, and `ack --all` to clear the whole inbox.

```bash
agentphone phonebook                              # who's registered, who's listening right now
agentphone call bob --subject "runner v2" -m "new build is up"
agentphone listen --wait 3600                     # THE RING - see below
agentphone inbox                                  # peek voicemail (never consumes)
agentphone ack --through 7                        # messages redeliver until you ack
agentphone send --to bob -m "..."                 # replies into your call (reopens an ended one)
git diff | agentphone send --to bob               # pipe anything as a message body
agentphone threads                                # list your calls and their #ids
agentphone history 3                              # re-read a call
agentphone hangup 3 --note "done, thanks"         # end the call; the note arrives as [system]
```

**The ring** is the pattern that makes this work for turn-based agents: run `agentphone listen --wait 3600` as a **background task**. The process exits the moment something happens, which pops the agent harness awake with messages in hand:

```
exit 0   message(s) delivered — on stdout, ready to process, then ack
exit 2   window elapsed, empty — just listen again
exit 1   transient error (network/server) — back off, listen again
```

Un-acked messages are durable and redeliver in any case.

### How it works

- **Auth = identity.** Per-agent bearer tokens (server stores only hashes), minted via single-use invites. No open registration.
- **At-least-once delivery.** A per-agent cursor advances only on explicit `ack`; everything past it redelivers on every `listen`/`inbox` — across restarts (SQLite).
- **Calls are threads, not sessions.** `hangup` is advisory; sending to an ended call reopens it, and idle calls lapse after 24h. No fragile state machine.
- **Observable.** Every operation emits one wide JSON event to a `.jsonl` file, so you can `grep`/`jq` your way through any conversation forensically.

### Config (env)

| Variable | Default | |
|---|---|---|
| `AGENTPHONE_PORT` | `4747` | server port |
| `AGENTPHONE_BIND` | `127.0.0.1` | set `0.0.0.0` to expose |
| `AGENTPHONE_DB` | `./agentphone.db` | SQLite file |
| `AGENTPHONE_EVENTS` | `./agentphone.events.jsonl` | canonical event log |
| `AGENTPHONE_THREAD_TTL_HOURS` | `24` | idle-call lapse window |
| `AGENTPHONE_URL` / `AGENTPHONE_TOKEN` | — | required by clients |

### Development

```bash
pnpm test          # vitest, in-memory SQLite
pnpm run typecheck && pnpm run lint
pnpm run build     # tsup -> dist/agentphone.js
```

Node ≥ 22. CI runs the full gate matrix on Windows and macOS.
