# Investigation: 30s+ message-read latency (agent-observed)

Status: DIAGNOSED 2026-07-15 — root causes quantified layer by layer; fixes scoped (see
"Optimization targets"). Original hypotheses and diagnostics preserved at the bottom.

## Symptom (reported 2026-07-15)

First real cross-machine session: `gha-docker-runner`/`desktop` (Windows, server host) ↔
`volumi` (MacBook). The **ring is instant** — the backgrounded `agentphone listen` pops the
moment a message is sent. But **reading a message via MCP or CLI takes 30+ seconds** as
observed by the agents/user.

## Verdict

The server, network, Docker proxy, and MCP protocol are all sub-5ms. The observed 30s+ is
**agent-loop wall-clock**: every tool call an agent makes costs a full think-act cycle
(~4–15s: model reasoning + streaming + harness round-trip), and "reading a message" took
agents 2–4 such cycles. One genuine client-side defect amplifies it: **every CLI verb costs
~610ms because the CLI eagerly imports the whole server stack** (MCP SDK + express) at
module scope.

## Evidence A — desktop session transcript (real usage, 2026-07-15)

Session `401f9695…` in `~/.claude/projects/O---web-omnith-gha-docker-runner/`, 49 agentphone
tool calls, correlated against server events:

| Path | Measured |
|---|---|
| volumi send → desktop's parked listen delivers | 0–2ms (server event `waitedMs` ends exactly at send ts) |
| listen exits → harness task-notification enqueued | 23–34ms (msg #2: 06:55:52.890 send, .913 enqueue) |
| notification → message content in agent context | ~9.5s (one think cycle + one Read of the ring's output file) |
| MCP tool call (tool_use emitted → server processes) | 1.5–4.5s each, n=6 — server `durationMs`=0 throughout |
| CLI batched call (send + ack in one bash call) | 2.0s total |
| foreground `listen --wait 150` inside a turn | blocked the turn 151s, delivered nothing |

The headline incidents dissolve on correlation:

- **msg #2 "took 9 minutes to answer"**: delivery + notification were instant; the agent had
  the message in-context 9.5s after send. The gap to its reply was the **user interrupting**
  to redirect the agent onto MCP installation (06:57–07:05), not latency.
- **msg #5**: send 07:26:24.991 → notification 07:26:25.025 → `history` read complete
  07:26:34.865. **~10s end-to-end**, of which 1.5s was the MCP call itself.
- **volumi's acks landed 51s–7.5min after instant delivery** — its own turn cadence and
  workload (it worked from ring stdout; it never issued a read verb for msg #4 at all).

Also observed: the ring's task-notification does **not** inline stdout — the agent spent one
think+Read cycle fetching the output file. And piping listen through `| tail -40` made the
agent's `$?` capture tail's exit, not the CLI's (the "listen-exit:0 on timeout" was an
artifact; the contract is intact — probe confirmed exit 2 on empty windows).

## Evidence B — layered probe (this box → live container, 2026-07-15)

`scratchpad/layer-probe.js`; bench-a/bench-b registered agents; n=5–10 per row:

| Layer | p50 |
|---|---|
| node process spawn (`node -e "0"`) | 41ms |
| HTTP GET /api/health, /phonebook, /inbox — loopback | 1.5–2.1ms |
| same via meshnet IP 100.110.150.142 (Docker proxy) | 0.9–1.2ms |
| raw MCP protocol: initialize / tools/call (single POST) | 3.7ms / 3.4ms |
| **full CLI process, any client verb** | **~610ms** |
| delivery pop: send → parked listener exits | ≤7ms after send |
| listen empty-window exit code | 2 (contract holds) |

CLI startup breakdown (unbundled imports): commander 14ms, zod 124ms, better-sqlite3 13ms,
express 236ms, **MCP SDK 1728ms**. `src/cli/index.ts` imports `startServer` and `SqliteStore`
at module scope, so every `inbox`/`send`/`ack` loads the whole server stack (bundled: ~570ms
of the 610ms) to run a 2ms HTTP request. Violates the repo's own lazy-init rule.

## Evidence C — agent-harness scenarios (2026-07-15)

- **Headless `claude -p`, 3 sequential MCP `phonebook` calls**: 28s total; inter-call gaps
  5.3s and 4.1s with server dur=0ms and protocol RTT 3ms. **A single MCP tool call costs a
  ~4–5s think-act cycle even in a minimal context.**
- **Scenario B (batched)**: full 9-verb conversation (phonebook→call→inbox→history→send→
  ack→inbox→ack→hangup) in ONE bash call: **5.9s wall-clock total** (~650ms/verb ≈ the CLI
  startup cost × 9).
- **Scenario A (naive, one verb per Bash tool call)**: same 9 verbs, one think-act cycle
  each: every command's `real` time was 0.63–0.73s, but the agent's total wall-clock was
  **86.5s** (~9.6s per verb cycle). Naive vs batched on identical work: **86.5s vs 5.9s**.

## Where the "30 seconds" actually goes (typical naive read)

```
ring delivers message            ~0ms      (server + notification: <50ms)
agent turn starts, thinks        3–10s
reads ring output file           1–2s      (tool round-trip)
thinks, decides to "verify"      3–10s
history/inbox call               0.6–4.5s  (CLI spawn 610ms | MCP cycle)
thinks, acks                     3–10s
ack call                         0.6–2.5s
                                 ─────────
                                 ≈ 12–40s  — all agent-loop, ~1% transport
```

## Optimization targets (ranked by measured impact)

1. **CLI: lazy-load the server stack** (`src/cli/index.ts` — dynamic-import `startServer`/
   `SqliteStore` inside the `serve`/`admin` actions; enable tsup code-splitting). ~610ms →
   ~200ms on every verb, both machines. This also multiplies through batched scripts (9-verb
   scenario: 5.9s → ~2s).
2. **Steer agents to fewer calls** (README + MCP tool descriptions): the ring output file
   already contains the messages — process it, don't re-fetch; batch verbs in one shell call
   (9 verbs = 5.9s batched vs ~9 think-cycles naive); never foreground-listen inside a turn;
   never pipe `listen` (exit code is the signal); `listen --ack` merges the ack; reply+ack in
   one bash call. MCP `listen` description must scream "WAITS up to waitMs — use inbox to
   read instantly".
3. **Graceful shutdown**: `serve` installs no SIGTERM/SIGINT handler — `docker stop` burns
   the 10s grace period then SIGKILLs (observed exit 137), dropping parked long-polls
   uncleanly. Close server + release waiters + close store on signal.
4. **(contract candidate) reply+ack in one round**: agents pair `ack` with their reply
   almost every exchange (observed both sides). An optional `ackThrough` on send/call would
   halve the calls in the tightest loop. Evaluate as part of the optimization increment.

## What remains open

- **H3 (Mac client-side)**: unmeasured — needs `time agentphone inbox` / `time node dist/…`
  on volumi (commands in the checklist below). The lazy-import fix helps it regardless; the
  corepack-shim and DNS questions stay open until measured.
- Windows firewall stall theory: dead (H4) — meshnet-IP RTT ≈ loopback RTT ≈ 1ms.

---

## Appendix: original hypotheses (pre-diagnosis) and their outcomes

- **H1 semantic trap (listen-as-read)** — partially real: one foreground `listen --wait 150`
  blocked a turn 151s; MCP listen (default waitMs 25000) was never actually used for reads in
  the observed session. Steering fix (target 2) still warranted.
- **H2 agent-loop overhead** — **confirmed dominant** (Evidence A + C).
- **H3 Mac client invocation** — open, see above.
- **H4 Docker/meshnet** — refuted (Evidence B).

### Mac-side checklist (run on volumi, outside any agent)

```bash
time curl -s -o /dev/null -w '%{time_total}\n' http://100.110.150.142:4747/api/health
time agentphone inbox            # expect ~0.6s+ today; ~0.2s after the lazy-import fix
time node <clone>/dist/agentphone.js inbox   # bypass shim chain
time corepack pnpm --version     # shim overhead in isolation
echo $AGENTPHONE_URL             # IP literal or hostname?
```

### Server event-correlation command (after any reproduction)

```powershell
docker exec agentphone node -e "const fs=require('fs');const l=fs.readFileSync('/data/agentphone.events.jsonl','utf8').trim().split('\n').slice(-40).map(JSON.parse);for(const e of l)console.log(new Date(e.ts).toISOString(),e.op,e.surface,e.agent,'dur='+e.durationMs,'wait='+(e.waitedMs??''))"
```

### Context for cold readers

- Server: Docker container `agentphone` on the Windows box (100.110.150.142:4747), image
  `ghcr.io/omnith/agentphone:latest` (private GHCR). Events at `/data/agentphone.events.jsonl`.
- The ring contract: exit 0 = delivered (messages on stdout), 2 = empty window, 1 = transient
  error. CLI listen loops ≤60s server polls up to `--wait` total.
- MCP `listen` tool: default waitMs 25000, max 60000. `inbox` tool = waitMs 0, never consumes.
- Delivery is at-least-once; messages redeliver until acked; `listen --ack` auto-acks.
- bench-a/b/c/d are throwaway benchmark identities registered 2026-07-15 (threads #2–#4).
