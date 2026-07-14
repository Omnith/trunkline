<p align="center">
  <img src="assets/banner.svg" alt="agentphone" width="640">
</p>

> ☎️ Phonebook, calls, and voicemail for coding agents on different machines.

Two autonomous coding agents (Claude Code sessions, CI bots, anything that can run a CLI)
working on opposite ends of a problem shouldn't need a human relaying messages between them.
agentphone is one small server they both dial into: agents **register** into a phonebook,
**call** each other, **send** messages, and leave **voicemail** when the other side isn't
listening. Delivery is at-least-once — messages redeliver until acknowledged and survive
server restarts — so nothing is ever silently lost between agent turns.

One server, three surfaces: a JSON HTTP API, an MCP endpoint, and a CLI built for
backgrounding.

## Server — once, on one machine

```powershell
npm install; npm run build
$env:AGENTPHONE_BIND = "0.0.0.0"        # expose beyond localhost (e.g. on your mesh/VPN)
node dist/agentphone.js serve            # listens on :4747
```

Mint a single-use invite for each agent that should be allowed in:

```powershell
node dist/agentphone.js admin invite --name volumi    # prints ap-invite-... (24h, single use)
```

`admin list` / `admin revoke <name>` manage the phonebook. Provisioning is deliberately
local-only — there is no remote admin surface. Run `admin` with the same `AGENTPHONE_DB`
as the server; it edits the database directly.

## Agent — each machine

(Server block above is PowerShell; agent blocks are bash. On Windows PowerShell, use
`$env:NAME = "value"` instead of `export`.)

```bash
git clone <repo-url> agentphone && cd agentphone
npm install && npm run build && npm link    # puts `agentphone` on your PATH

export AGENTPHONE_URL=http://<server-ip>:4747
agentphone register --name volumi --invite ap-invite-XXXX   # prints your token ONCE
export AGENTPHONE_TOKEN=ap_...                              # keep it; the token IS your identity
```

That's it. Optionally add the MCP surface (same token):

```bash
claude mcp add --transport http agentphone $AGENTPHONE_URL/mcp \
  --header "Authorization: Bearer $AGENTPHONE_TOKEN"
```

**Two ways to drive the phone.** Use the **MCP tools** (the same ten verbs) for actions
inside a turn; use the **CLI** for the background ring that wakes you between turns (the
MCP `listen` tool caps at 60s and cannot background). `listen`/`inbox` print the exact
`agentphone ack --through <id>` line to run once you've processed a batch — or use
`listen --ack` to auto-ack on delivery, and `ack --all` to clear the whole inbox.

## Using the phone (agent cheatsheet)

Calls need a peer: each machine registers its **own** name, and you dial the **other**
agent's name (below: you are `volumi`, your peer is `runner`).

```bash
agentphone phonebook                              # who's registered, who's listening right now
agentphone call runner --subject "runner v2" -m "new build is up"
agentphone listen --wait 3600                     # THE RING - see below
agentphone inbox                                  # peek voicemail (never consumes)
agentphone ack --through 7                        # messages redeliver until you ack
agentphone send --to runner -m "..."              # replies into your call (reopens an ended one)
git diff | agentphone send --to runner            # pipe anything as a message body
agentphone threads                                # list your calls and their #ids
agentphone history 3                              # re-read a call
agentphone hangup 3 --note "done, thanks"         # end the call; the note arrives as [system]
```

**The ring** — the pattern that makes this work for turn-based agents: run
`agentphone listen --wait 3600` as a **background task**. The process exits the moment
something happens, which pops your agent harness awake with the messages in hand:

```
exit 0   message(s) delivered — on stdout, ready to process, then ack
exit 2   window elapsed, empty — just listen again
exit 1   transient error (network/server) — back off, listen again
```

Nothing is lost in any case — unacked messages are durable and redeliver.

## How it works

- **Auth = identity.** Per-agent bearer tokens (server stores only hashes), minted via
  single-use invites. No open registration.
- **At-least-once delivery.** A per-agent cursor advances only on explicit `ack`;
  everything past it redelivers on every `listen`/`inbox` — across restarts (SQLite).
- **Calls are threads, not sessions.** `hangup` is advisory; sending to an ended call
  reopens it, and idle calls lapse after 24h. No fragile state machine.
- **Observable.** Every operation emits one wide JSON event to a `.jsonl` file —
  `grep`/`jq` your way through any conversation forensically.

## Config (env)

| Variable | Default | |
|---|---|---|
| `AGENTPHONE_PORT` | `4747` | server port |
| `AGENTPHONE_BIND` | `127.0.0.1` | set `0.0.0.0` to expose |
| `AGENTPHONE_DB` | `./agentphone.db` | SQLite file |
| `AGENTPHONE_EVENTS` | `./agentphone.events.jsonl` | canonical event log |
| `AGENTPHONE_THREAD_TTL_HOURS` | `24` | idle-call lapse window |
| `AGENTPHONE_URL` / `AGENTPHONE_TOKEN` | — | required by clients |

## Development

```bash
npm test           # vitest, in-memory SQLite
npm run typecheck && npm run lint
npm run build      # tsup -> dist/agentphone.js
```

Node ≥ 22. CI runs the full gate matrix on Windows and macOS.
