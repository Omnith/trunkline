# Increment 3 — read-latency optimizations: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. All implementers MUST invoke `superpowers:test-driven-development` first and follow the repo Testing Methodology (behavior-level, minimum-optimal, no implementation-detail coupling).

**Goal:** Cut the measurable client/server waste found in `docs/investigations/2026-07-15-read-latency.md`: lazy-load the server stack out of CLI verbs (~610ms → ≤250ms), graceful shutdown (docker stop exit 137 → clean fast exit), reply+ack in one round (`send.ackThrough`), and agent steering docs.

**Architecture:** Composition root (`src/cli/index.ts`) becomes lazy: server/admin actions dynamic-import the HTTP/store subtree; tsup emits split chunks. Core gains `Waiters.releaseAll` → `PhoneService.releaseWaiters` → `startServer().close()` ordering (release, then close). `SendInputSchema` gains optional `ackThrough` sharing ack's cursor semantics via one private helper. Dependency DAG unchanged.

**Tech stack:** TypeScript, zod, express, MCP SDK, better-sqlite3, tsup (esm + splitting), vitest.

**Branch:** `feat/ffl-3-latency`

---

### Task 1: Lazy server stack in the CLI (G1)

**Files:**
- Modify: `tsup.config.ts`
- Modify: `src/cli/index.ts:1-35` (imports, `adminStore`), `:169-173` (serve), `:175-228` (admin actions)

No new tests: import topology is an implementation detail; AC1 is verified by measurement (Task 5). The existing suite must stay green — that is the behavioral guard.

- [ ] **Step 1: tsup splitting**

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { agentphone: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node22',
  splitting: true,
  clean: true,
  sourcemap: true,
})
```

- [ ] **Step 2: make the CLI composition lazy**

In `src/cli/index.ts` delete the two static imports:

```ts
import { startServer } from '../http/server.js'   // DELETE
import { SqliteStore } from '../store/sqlite.js'  // DELETE
```

Replace `adminStore` with an async loader (callers below):

```ts
const adminStore = async () => {
  const { SqliteStore } = await import('../store/sqlite.js')
  return new SqliteStore(process.env.AGENTPHONE_DB ?? './agentphone.db')
}
```

Serve action:

```ts
program.command('serve').action(async () => {
  const { startServer } = await import('../http/server.js')
  const cfg = loadServerConfig(process.env)
  const running = await startServer(cfg)
  out(`agentphone listening on ${cfg.bind}:${running.port} (db: ${cfg.dbPath})`)
})
```

Each admin action becomes async and awaits the store, e.g.:

```ts
admin.command('add <name>').action(async (name: string) => {
  const store = await adminStore()
  try {
    const res = addAgent(store, systemClock, name)
    out(`agent "${res.name}" added`)
    out(`token (shown once - deliver securely): ${res.token}`)
  } catch (e) {
    fail(e)
  } finally {
    store.close()
  }
})
```

(same async/await change for `admin invite`, `admin list`, `admin revoke`; body logic unchanged. Note `addAgent`/`createInvite` etc. stay statically imported from `core/provisioning.js` — they pull no heavy deps.)

- [ ] **Step 3: gates + quick measurement**

Run: `pnpm run build` then `pnpm run typecheck && pnpm run lint && pnpm test`
Expected: all pass; `dist/` now contains `agentphone.js` plus at least one chunk file.
Run: `head -1 dist/agentphone.js` — the `#!/usr/bin/env node` shebang must survive splitting
(the `bin` entry depends on it; plan-review LOW-2).
Run: `node dist/agentphone.js --help` (instant) and a manual smoke of the lazy paths —
`node dist/agentphone.js admin list` with a temp `AGENTPHONE_DB`, and `serve` on an ephemeral
port with ctrl-c — since no suite test exercises serve/admin; the guards here are typecheck +
this smoke (plan-review L3). Formal numbers in Task 5.

- [ ] **Step 4: commit**

```bash
git add tsup.config.ts src/cli/index.ts
git commit -m "perf(cli): lazy-load server stack so client verbs skip express/mcp-sdk/sqlite"
```

### Task 2: drain-aware releaseAll + graceful shutdown (G2)

**Plan-review rev 2:** `releaseAll` alone is NOT sufficient (arch HIGH-1): the listen loop in
`src/core/service.ts:261-281` re-checks `records.length > 0 || elapsed >= waitMs` after every
wakeup — a shutdown wake has no new message and elapsed ≪ waitMs, so the handler would simply
**re-park**. The exit condition must also consult a draining flag. Do NOT weaken the tests if
close hangs — the re-park is the bug.

**Files:**
- Modify: `src/core/waiters.ts`, `src/core/service.ts` (listen exit condition + `releaseWaiters`), `src/http/server.ts`, `src/cli/index.ts` (serve action)
- Test: `src/core/waiters.test.ts`, `src/core/service.delivery.test.ts`, `src/http/server.test.ts`

- [ ] **Step 1: failing tests — waiter release AND service-level drain**

```ts
// src/core/waiters.test.ts (add)
it('releaseAll wakes every parked waiter and clears listening state', async () => {
  const w = new Waiters()
  const a = w.wait('volumi', 60_000)
  const b = w.wait('desktop', 60_000)
  w.releaseAll()
  await Promise.all([a, b]) // resolves without waiting out the window
  expect(w.isListening('volumi')).toBe(false)
  expect(w.isListening('desktop')).toBe(false)
})
```

```ts
// src/core/service.delivery.test.ts (add — this is the test that encodes HIGH-1;
// use this file's real fixtures: twoAgents() harness h, ctxs gha/vol)
it('releaseWaiters resolves an in-flight listen empty instead of re-parking', async () => {
  const h = twoAgents()
  const parked = h.service.listen(gha, { waitMs: 60_000 })
  await new Promise((r) => setTimeout(r, 20)) // let it park
  h.service.releaseWaiters()
  const res = await parked // must resolve now, not after 60s
  expect(res.messages).toEqual([])
})
```

- [ ] **Step 2: run both — fail** (`releaseAll`/`releaseWaiters` not a function; second test
  would time out even with a bare notify-based releaseAll — that is the point)

- [ ] **Step 3: implement drain-aware release**

```ts
// src/core/waiters.ts (add)
private draining = false

isDraining(): boolean {
  return this.draining
}

releaseAll(): void {
  this.draining = true
  for (const agent of [...this.parked.keys()]) this.notify(agent)
}
```

```ts
// src/core/service.ts — listen exit condition (service.ts:269) gains the drain check:
if (records.length > 0 || elapsed >= input.waitMs || this.waiters.isDraining()) {
```

(The flag must live in the **return condition**, not inside `wait()` — a resolve-immediately
`wait()` with an unchanged exit condition would busy-loop.)

```ts
// src/core/service.ts (add near isListening)
releaseWaiters(): void {
  this.waiters.releaseAll()
}
```

- [ ] **Step 4: failing test — server close resolves a parked HTTP listen promptly**

The real HTTP contract (from `src/http/app.ts` / `client.ts`): register is
`POST /api/register` → **201** `{ name, token }`; listen/park is **`GET /api/inbox?waitMs=…`**
with only the bearer header (do NOT invent a `/api/listen` route — plan-review H2/LOW-1).

```ts
// src/http/server.test.ts (add; follow the file's existing temp-path conventions)
it('close() releases parked long-polls, then shuts down cleanly', async () => {
  const dbPath = join(tmpdir(), `ap-shutdown-${process.pid}-${Date.now()}.db`)
  const provisioning = new SqliteStore(dbPath)
  const invite = createInvite(provisioning, systemClock, { ttlHours: 1 })
  provisioning.close()

  const running = await startServer({
    port: 0, bind: '127.0.0.1', dbPath,
    eventsPath: join(tmpdir(), `ap-shutdown-${process.pid}-${Date.now()}.jsonl`),
    threadTtlHours: 24,
  })
  const base = `http://127.0.0.1:${running.port}`
  const reg = await fetch(`${base}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'parked', inviteCode: invite.code }),
  })
  expect(reg.status).toBe(201)
  const { token } = await reg.json()

  const parked = fetch(`${base}/api/inbox?waitMs=30000`, {
    headers: { authorization: `Bearer ${token}` },
  })
  await new Promise((r) => setTimeout(r, 150)) // let it park

  const t0 = Date.now()
  await running.close()
  const res = await parked
  expect(res.status).toBe(200)
  expect((await res.json()).messages).toEqual([])
  expect(Date.now() - t0).toBeLessThan(5_000) // not the 30s window, and not undici keep-alive
  await running.close() // idempotent: second close must not throw (MEDIUM-2)
})
```

- [ ] **Step 5: run it — fails** (close hangs until the poll window / keep-alive timeout)

- [ ] **Step 6: implement idempotent release-then-drain-then-close + shutdown event**

Keep-alive reality (plan-review H3/MEDIUM-1): undici `fetch` pools sockets; `srv.close()`
never reaps idle keep-alive connections, and a single `closeIdleConnections()` call races the
just-released response (its socket is still active at that instant, idle only after flush).
Reap on a short unref'd interval until close completes — this only ever touches **idle**
sockets, so in-flight responses are never truncated:

```ts
// src/http/server.ts — inside startServer, before resolve(...):
let closing: Promise<void> | undefined
const doClose = (): Promise<void> => {
  const start = systemClock.now()
  service.releaseWaiters()
  return new Promise<void>((done) => {
    const reaper = setInterval(() => srv.closeIdleConnections(), 25)
    reaper.unref()
    srv.close(() => {
      clearInterval(reaper)
      store.close()
      emitter.emit({
        ts: start, op: 'shutdown', surface: 'http', agent: null,
        outcome: 'ok', durationMs: systemClock.now() - start,
      })
      done()
    })
    srv.closeIdleConnections()
  })
}
// in the resolved RunningServer:
close: () => (closing ??= doClose()),
```

Notes: `PhoneEvent.op` is already `string` — `'shutdown'` needs NO type change; do not add an
op union or `as any` (arch MEDIUM-4 note). `JsonlEmitter` appends synchronously, so the event
is durable before exit.

- [ ] **Step 7: wire signals in serve (thin shell — close() logic is what the tests prove;
  the wiring is verified via docker in Task 5)**

```ts
program.command('serve').action(async () => {
  const { startServer } = await import('../http/server.js')
  const cfg = loadServerConfig(process.env)
  const running = await startServer(cfg)
  out(`agentphone listening on ${cfg.bind}:${running.port} (db: ${cfg.dbPath})`)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      running.close().then(
        () => process.exit(0),
        () => process.exit(1), // a swallowed rejection would hang to SIGKILL (MEDIUM-3)
      )
    })
  }
})
```

(`close()` is idempotent via the `closing ??=` guard, so SIGTERM+SIGINT double-delivery is
safe.)

- [ ] **Step 8: run the full suite — passes.** Commit:

```bash
git add src/core/waiters.ts src/core/waiters.test.ts src/core/service.ts src/http/server.ts src/http/server.test.ts src/cli/index.ts
git commit -m "feat(http,core): graceful shutdown - release parked long-polls, close store, handle SIGTERM/SIGINT"
```

### Task 3: send.ackThrough — reply+ack in one round (G3)

**Plan-review rev 2 (arch HIGH-2 / tests H1):** `PhoneClient.send` (`src/client/client.ts:84-88`)
serializes ONLY `{ body: input.body }` — without changing it, the CLI flag parses fine and the
field silently never reaches the wire (the classic reviewed-as-minor production no-op). The
client file is in scope and the load-bearing guard is a **real-PhoneClient round-trip test**.

**Files:**
- Modify: `src/core/contracts.ts:65-68`, `src/core/ports.ts` (PhoneEvent), `src/core/service.ts` (ack + send + EventFields), **`src/client/client.ts` (send forwards ackThrough)**, `src/cli/index.ts` (send command), `src/cli/commands.ts` (`sendTo`), `src/mcp/tools.ts` (send description only — schema flows via `.shape`)
- Test: `src/core/service.delivery.test.ts`, **`src/client/client.test.ts`**, `src/cli/commands.test.ts`

- [ ] **Step 1: failing service test** — written against this file's REAL fixtures
  (`twoAgents()` harness `h`, ctxs `gha`/`vol`, threads created via `h.service.call`):

```ts
// src/core/service.delivery.test.ts (add)
it('send with ackThrough advances the sender cursor with ack semantics and still delivers', async () => {
  const h = twoAgents()
  const { thread } = await h.service.call(gha, { to: 'volumi', subject: 's', body: 'm1' })
  await h.service.send(gha, { threadId: thread.id, body: 'm2' })

  const before = await h.service.listen(vol, { waitMs: 0 })
  expect(before.messages.length).toBe(2)

  const res = await h.service.send(vol, { threadId: thread.id, body: 'reply', ackThrough: before.cursor })
  expect(res.message.body).toBe('reply')

  const after = await h.service.listen(vol, { waitMs: 0 })
  expect(after.messages).toEqual([]) // inbox cleared in the same round

  // peer still receives the reply (delivery unaffected by the piggyback)
  const peer = await h.service.listen(gha, { waitMs: 0 })
  expect(peer.messages.map((m) => m.body)).toContain('reply')

  // capped exactly like ack: an absurd id clamps to the max existing message id
  await h.service.send(vol, { threadId: thread.id, body: 'reply2', ackThrough: 999_999 })
  const cursor = await h.service.ack(vol, { throughMessageId: 0 }) // no-op read of cursor
  expect(cursor.ackedThroughMessageId).toBe(h.store.maxMessageId())

  // canonical wide event carries the piggyback (observability contract, MEDIUM-4)
  const ev = h.emitter.events.find((e) => e.op === 'send' && e.ackedThrough !== undefined)
  expect(ev?.ackedThrough).toBe(before.cursor)
})
```

(Adapt the exact fixture/property names to what `twoAgents()` really exposes — `h.store`,
`h.emitter` per the file's existing tests — but keep every assertion. Assert behavior through
the public service interface only.)

- [ ] **Step 2: run — fails** (zod strips/rejects `ackThrough`, cursor not advanced)

- [ ] **Step 3: implement core**

```ts
// src/core/contracts.ts — SendInputSchema gains (positive() is intentional: acking through 0
// on a send is meaningless; ack's own min(0) is unchanged — noted asymmetry, plan-review L1):
ackThrough: z.number().int().positive().optional(),
```

```ts
// src/core/ports.ts — PhoneEvent gains (unconditional; the {...ev} spread would compile
// without it but the canonical event is a product contract — MEDIUM-4):
ackedThrough?: number
```

```ts
// src/core/service.ts — one shared helper; ack() and send() both use it
private advanceCursor(agent: string, through: number): number {
  const current = this.store.getCursor(agent)
  const cap = this.store.maxMessageId()
  const next = Math.max(current, Math.min(through, cap))
  this.store.setCursor(agent, next)
  return next
}
```

`ack()` body becomes `return { ackedThroughMessageId: this.advanceCursor(ctx.agent, input.throughMessageId) }`.
In `send()`, first line inside the op callback after `requireParticipant`:

```ts
if (input.ackThrough !== undefined) {
  ev.ackedThrough = this.advanceCursor(ctx.agent, input.ackThrough)
}
```

Add `ackedThrough?: number` to `EventFields` too.

- [ ] **Step 4: failing real-client round-trip test — the guard that catches the wire drop**

```ts
// src/client/client.test.ts (add, following the file's existing boot-real-app style)
it('send forwards ackThrough so the sender inbox clears in one round', async () => {
  // per the file's harness: real app + PhoneClient for two agents a/b, thread seeded a->b
  const got = await b.inbox()
  expect(got.messages.length).toBeGreaterThan(0)
  await b.send({ threadId, body: 'reply', ackThrough: got.cursor })
  const after = await b.inbox()
  expect(after.messages).toEqual([]) // fails while PhoneClient drops ackThrough
})
```

Run — MUST fail (inbox still populated) before touching the client. Then implement:

```ts
// src/client/client.ts — send() forwards the field:
send(input: SendInput): Promise<SendOutput> {
  return this.req('POST', `/api/calls/${input.threadId}/messages`, SendOutputSchema, {
    body: input.body,
    ackThrough: input.ackThrough,
  })
}
```

Re-run — green. (No separate raw-fetch `app.test.ts` case: the send route returns 201 and has
no happy-path template there; this real-client test proves boundary acceptance AND wire
serialization in one — plan-review M4.)

- [ ] **Step 5: CLI flag**

```ts
// src/cli/index.ts — send command gains:
.option('--ack-through <id>', 'ack your inbox through this message id in the same round')
```

Thread both paths through (`ackThrough: o.ackThrough !== undefined ? Number(o.ackThrough) : undefined`),
and give `sendTo` an optional `ackThrough` parameter it forwards to `c.send`. Add one
`commands.test.ts` case per that file's fake-client conventions proving `sendTo` forwards it.

- [ ] **Step 6: MCP description** (schema already flows via `SendInputSchema.shape` — that
  reuse IS the AC3-MCP discharge; a dedicated MCP test would only re-assert zod's `.shape`,
  which is dependency-owned — plan-review L2): send tool description becomes
  `'Send a message into an existing thread (reopens an ended thread). Pass ackThrough to also ack your inbox through that id — reply+ack in one call.'`

- [ ] **Step 7: full suite green. Commit:**

```bash
git add src/core/contracts.ts src/core/ports.ts src/core/service.ts src/core/service.delivery.test.ts src/client/client.ts src/client/client.test.ts src/cli/index.ts src/cli/commands.ts src/cli/commands.test.ts src/mcp/tools.ts
git commit -m "feat(core): send.ackThrough - reply and ack in one round on every surface"
```

### Task 4: steering docs (G4)

**Files:**
- Modify: `README.md` (agent section + cheatsheet), `src/mcp/tools.ts` (listen description)

- [ ] **Step 1: MCP listen description** →

```
'WAITS up to waitMs (default 25s) for unacked messages; returns immediately only if some are already waiting. To read without waiting use inbox or history. For the background ring, use the CLI: `agentphone listen --wait 3600` as a background task.'
```

- [ ] **Step 2: README — add a "Keep it fast" block to the agent section:**

```markdown
**Keep it fast.** Every tool call you make costs you a full think-act cycle; the phone itself
is milliseconds. Four rules:

1. **The ring already delivered the messages** — `listen` prints them on exit. Process them
   from its output; don't re-fetch with `inbox`/`history`.
2. **Batch phone verbs in one shell call** (`inbox; ack --all; send ...` chained) instead of
   one call per verb.
3. **Reply and ack in one round:** `agentphone send --thread 3 --ack-through 7 -m "..."`.
4. **Never run `listen` in the foreground of a turn, and never pipe it** (`| tail` eats the
   exit code — exit 0 delivered / 2 empty / 1 transient error is the signal).
```

- [ ] **Step 3: lint (prettier covers md), commit:**

```bash
git add README.md src/mcp/tools.ts
git commit -m "docs: agent latency playbook - ring output is the read, batch verbs, one-round reply+ack"
```

### Task 5: verification, evidence, cleanup

- [ ] **Step 1: gates** — `pnpm run build && pnpm run typecheck && pnpm run lint && pnpm test` all green (direct commands, never trust wrapped summaries).
- [ ] **Step 2: AC1 measurement** — time 5× `node dist/agentphone.js inbox` (and `phonebook`) against the live container with a bench token; record p50 before(≈610ms)/after in `impl.md`.
- [ ] **Step 3: AC2 measurement** — `docker compose up -d --build`, then `Measure-Command { docker stop agentphone }`; expect ≲2s and clean logs; `docker start agentphone` after. Record.
- [ ] **Step 4: cleanup** — `docker exec agentphone node dist/agentphone.js admin revoke bench-a` (and b/c/d).
- [ ] **Step 5: write `docs/increment-3-latency/impl.md`** (decisions, deviations, evidence, deferred debt), commit docs.

### PR

Per repo process: push, `gh pr create --fill`, parallel spec-conformance + code-quality reviews, fix HIGH/MEDIUM, re-verify, `gh pr merge --merge --delete-branch`.
