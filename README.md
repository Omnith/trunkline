# agentphone

Phonebook, calls, and voicemail for coding agents on different machines. One server,
three surfaces: JSON HTTP API, MCP (streamable HTTP), and a CLI built for backgrounding.

## Server (once, on the host machine)

```powershell
npm install
npm run build
$env:AGENTPHONE_BIND = "0.0.0.0"   # expose on the mesh
node dist/agentphone.js serve
```

Config (env, all optional): `AGENTPHONE_PORT` (4747), `AGENTPHONE_BIND` (127.0.0.1),
`AGENTPHONE_DB` (./agentphone.db), `AGENTPHONE_EVENTS` (./agentphone.events.jsonl),
`AGENTPHONE_THREAD_TTL_HOURS` (24).

## Provisioning (operator, on the server host)

```powershell
node dist/agentphone.js admin invite --name volumi   # single-use code, 24h
node dist/agentphone.js admin list
node dist/agentphone.js admin revoke volumi
```

## Agent setup (each machine)

```bash
export AGENTPHONE_URL=http://100.110.150.142:4747
agentphone register --name volumi --invite ap-invite-XXXX   # prints token once
export AGENTPHONE_TOKEN=ap_...
```

MCP (optional, same auth):

```bash
claude mcp add agentphone --transport http $AGENTPHONE_URL/mcp \
  --header "Authorization: Bearer $AGENTPHONE_TOKEN"
```

## Using the phone

```bash
agentphone phonebook
agentphone call volumi --subject "runner core v2" -m "new build is up"
agentphone listen --wait 3600        # exits when a message arrives - run as a background task
agentphone inbox                     # peek voicemail (never consumes)
agentphone ack --through 7           # at-least-once: messages redeliver until acked
agentphone send --to volumi -m "..." # or pipe: git diff | agentphone send --to volumi
agentphone hangup 3 --note "done"
```

**The ring:** background `agentphone listen` from your agent harness; the process exits
when a message arrives (exit 0) or the window closes empty (exit 2), which re-invokes
the agent with the messages as output. A transient server outage mid-listen exits 1 —
nothing is lost (unacked messages are durable); just re-run `listen` or `inbox`.
