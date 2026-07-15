# Investigation: 30s+ message-read latency (agent-observed)

Status: OPEN — diagnosis in progress. This doc is the compact-resilient anchor: symptom,
ground truth, ranked hypotheses, ready-to-run diagnostics, candidate fixes.

## Symptom (reported 2026-07-15)

First real cross-machine session: `gha-docker-runner` (Windows, server host) ↔ `volumi`
(MacBook). The **ring is instant** — the backgrounded `agentphone listen` pops the moment a
message is sent. But **reading a message via MCP or CLI takes 30+ seconds** as observed by
the agents/user.

## Ground truth (server events, pulled 2026-07-15 from the live container)

`docker exec agentphone node -e "…"` over `/data/agentphone.events.jsonl` (71 events, last 200 analyzed):

| op:surface | n | durMs p50 | durMs max | waitMs p50 |
|---|---|---|---|---|
| listen:http | 48 | 60000 | 60014 | 60000 |
| register/phonebook/call/ack/threads/send :http | 16 | 0-3 | 3 | 0 |
| phonebook/history/send/ack/hangup :mcp | 7 | 0 | 0 | 0 |

**Conclusions from ground truth:**
1. The server is sub-millisecond on every read/write verb, both surfaces. Server-side
   processing is NOT the bottleneck.
2. The 48 × 60s `listen:http` events are the ring's internal ≤60s long-polls looping while
   parked — by design, not a defect.
3. Notably absent: `listen:mcp` events in the sample, and no listen events with small-but-
   nonzero waits that would indicate "agent waited a bit then got the message".

## Ranked hypotheses

**H1 (most likely) — semantic trap: agents "read" with `listen` on an already-empty queue.**
If the ring ran with `--ack` (auto-ack), or the agent acked earlier, the queue is empty when
the agent then tries to "read the message" with `listen` (CLI: parks up to `--wait`, looping
60s polls) or the MCP `listen` tool (**default waitMs=25000 — parks 25s on an empty queue**,
which plus agent-turn overhead ≈ the observed 30s). The correct read verbs are `inbox` (peek,
instant) and `history <thread>` (instant). Fix direction: docs/tool-description steering, and
possibly make the MCP `listen` description scream "returns immediately only if unacked
messages exist; use inbox/history to READ"; consider lowering the MCP default wait.

**H2 — agent-loop overhead, not agentphone at all.** A Claude Code agent's wall-clock between
"ring fired" and "read command actually executed" includes its own turn reasoning, tool
permission prompts, and (on the Mac) CLI spawn. The server sees 0ms; the human sees 30s.
Diagnose by timing the bare commands outside the agent (see below).

**H3 — client-side invocation overhead on the Mac.** `pnpm link --global` shim → corepack →
node chain can add latency (corepack sometimes phones home to verify pnpm versions);
Node fetch to a hostname (if `AGENTPHONE_URL` uses a name rather than the 100.x IP) can hit
IPv6/DNS timeout-then-fallback delays. Diagnose with `time` on the Mac (H2 commands) and
comparing `time node <path>/dist/agentphone.js inbox` vs `time agentphone inbox`.

**H4 (unlikely, cheap to check) — Docker Desktop port-proxy or meshnet first-connection
latency.** Ring instancy argues against it, but confirm with curl timing from the Mac.

## Ready-to-run diagnostics (post-compact checklist)

On the **MacBook** (volumi side), outside any agent:

```bash
time curl -s -o /dev/null -w '%{time_total}\n' http://100.110.150.142:4747/api/health
time agentphone inbox            # expect instant if unacked exist or queue empty
time agentphone history 1        # expect instant
time node "$(pnpm root -g)/agentphone/dist/agentphone.js" inbox   # bypass shim chain
time corepack pnpm --version     # shim overhead in isolation
echo $AGENTPHONE_URL             # IP literal or hostname?
```

On the **server** (Windows box), after a reproduction:

```powershell
docker exec agentphone node -e "const fs=require('fs');const l=fs.readFileSync('/data/agentphone.events.jsonl','utf8').trim().split('\n').slice(-40).map(JSON.parse);for(const e of l)console.log(e.ts,e.op,e.surface,e.agent,'dur='+e.durationMs,'wait='+(e.waitedMs??''))"
```

Correlate: wall-clock timestamp of the slow read (agent transcript) vs the matching event's
`ts`+`durationMs`. Gap before the event's `ts` = client/agent-side; `durationMs` large =
server-side parking (H1).

Ask the volumi session: WHICH exact command/tool did it use to "read" (listen vs inbox vs
history), and whether its ring uses `--ack`.

## Candidate fixes (pending diagnosis)

- H1: README + MCP tool-description clarity ("listen WAITS; inbox/history READ"); consider
  MCP `listen` default waitMs 25000 → lower (e.g. 5000) or keep but document loudly; possibly
  a `read` CLI alias for inbox+history-of-latest-thread.
- H2: guidance in README's agent section: after the ring delivers (it PRINTS the messages),
  the agent already has the content — no second read needed unless it wants history.
- H3: recommend IP literals in AGENTPHONE_URL; document `node dist/...` direct invocation as
  the fast path; check corepack shim behavior on macOS.
- H4: n/a expected.

## Context for cold readers

- Server: Docker container `agentphone` on the Windows box (100.110.150.142:4747), image
  `ghcr.io/omnith/agentphone:latest` (private GHCR), healthy. Events at `/data/agentphone.events.jsonl`.
- Architecture and event schema: `docs/overview.md`, `docs/increment-1-agentphone-core/design.md`
  (PhoneEvent: ts/op/surface/agent/outcome/durationMs/waitedMs/...).
- The ring contract: exit 0 = delivered (messages on stdout), 2 = empty window, 1 = transient
  error. CLI listen loops ≤60s server polls up to `--wait` total.
- MCP `listen` tool: default waitMs 25000, max 60000. `inbox` tool = waitMs 0, never consumes.
- Delivery is at-least-once; messages redeliver until acked; `listen --ack` auto-acks on delivery.
