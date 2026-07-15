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
Run: `node dist/agentphone.js --help` and eyeball it is subjectively instant; formal numbers in Task 5.

- [ ] **Step 4: commit**

```bash
git add tsup.config.ts src/cli/index.ts
git commit -m "perf(cli): lazy-load server stack so client verbs skip express/mcp-sdk/sqlite"
```

### Task 2: releaseAll + graceful shutdown (G2)

**Files:**
- Modify: `src/core/waiters.ts`, `src/core/service.ts`, `src/http/server.ts`, `src/cli/index.ts` (serve action), `src/core/ports.ts` (event type, only if op unions/fields are typed there)
- Test: `src/core/waiters.test.ts`, `src/http/server.test.ts`

- [ ] **Step 1: failing test — releaseAll wakes parked waiters**

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

- [ ] **Step 2: run it — fails** (`releaseAll is not a function`)

- [ ] **Step 3: implement**

```ts
// src/core/waiters.ts (add method)
releaseAll(): void {
  for (const agent of [...this.parked.keys()]) this.notify(agent)
}
```

- [ ] **Step 4: failing test — server close resolves a parked HTTP listen promptly**

```ts
// src/http/server.test.ts (add; follow the file's existing startServer test conventions
// for temp db paths and config construction)
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
  }).then((r) => r.json())

  const parked = fetch(`${base}/api/listen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ waitMs: 30_000 }),
  })
  await new Promise((r) => setTimeout(r, 150)) // let it park

  const t0 = Date.now()
  await running.close()
  const res = await parked
  expect(res.status).toBe(200)
  expect((await res.json()).messages).toEqual([])
  expect(Date.now() - t0).toBeLessThan(5_000) // not the 30s window
})
```

(Adapt endpoint paths/register body to the actual HTTP contract in `src/http/app.ts` — verify before writing; the shape above is from the API used by `PhoneClient`.)

- [ ] **Step 5: run it — fails** (close hangs until the poll window ends / test times out)

- [ ] **Step 6: implement release-then-close + shutdown event**

```ts
// src/core/service.ts (add near isListening)
releaseWaiters(): void {
  this.waiters.releaseAll()
}
```

```ts
// src/http/server.ts — close() becomes:
close: () => {
  const start = systemClock.now()
  service.releaseWaiters()
  return new Promise<void>((done) => {
    srv.close(() => {
      store.close()
      emitter.emit({
        ts: start, op: 'shutdown', surface: 'http', agent: null,
        outcome: 'ok', durationMs: systemClock.now() - start,
      })
      done()
    })
  })
},
```

(If the emitter's event type constrains `op`, extend it where it is defined. If node keep-alive
sockets hold `srv.close` open after responses complete, add `srv.closeIdleConnections()`
immediately after calling `srv.close(...)` — part of this step, not a new design decision.)

- [ ] **Step 7: wire signals in serve (manual-verify path, no unit test — signal wiring is a
  thin shell; proven via docker in Task 5)**

```ts
program.command('serve').action(async () => {
  const { startServer } = await import('../http/server.js')
  const cfg = loadServerConfig(process.env)
  const running = await startServer(cfg)
  out(`agentphone listening on ${cfg.bind}:${running.port} (db: ${cfg.dbPath})`)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      void running.close().then(() => process.exit(0))
    })
  }
})
```

- [ ] **Step 8: run the full suite — passes.** Commit:

```bash
git add src/core/waiters.ts src/core/waiters.test.ts src/core/service.ts src/http/server.ts src/http/server.test.ts src/cli/index.ts
git commit -m "feat(http,core): graceful shutdown - release parked long-polls, close store, handle SIGTERM/SIGINT"
```

### Task 3: send.ackThrough — reply+ack in one round (G3)

**Files:**
- Modify: `src/core/contracts.ts:65-68`, `src/core/service.ts` (ack + send + EventFields), `src/cli/index.ts` (send command), `src/cli/commands.ts` (`sendTo`), `src/mcp/tools.ts` (send description only — schema flows via `.shape`)
- Test: `src/core/service.delivery.test.ts`, `src/http/app.test.ts`, `src/cli/commands.test.ts`

- [ ] **Step 1: failing service tests**

```ts
// src/core/service.delivery.test.ts (add)
it('send with ackThrough advances the sender cursor with ack semantics, and still delivers', async () => {
  // arrange per this file's existing helpers: two agents a/b, b has sent messages 1..2 to a
  const before = await svc.listen(ctxA, { waitMs: 0 })
  expect(before.messages.length).toBe(2)

  const res = await svc.send(ctxA, { threadId, body: 'reply', ackThrough: before.cursor })
  expect(res.message.body).toBe('reply')

  const after = await svc.listen(ctxA, { waitMs: 0 })
  expect(after.messages).toEqual([]) // inbox cleared in the same round

  // idempotent + capped, exactly like ack
  const again = await svc.send(ctxA, { threadId, body: 'reply2', ackThrough: 999_999 })
  expect(again.message.body).toBe('reply2')
  const cursorNow = await svc.ack(ctxA, { throughMessageId: 1 }) // lower id must not regress
  expect(cursorNow.ackedThroughMessageId).toBeGreaterThanOrEqual(before.cursor)
})
```

(Write against the file's existing fixture helpers — do not invent new fixtures; assert
behavior through the public service interface only.)

- [ ] **Step 2: run — fails** (zod strips/rejects `ackThrough`, cursor not advanced)

- [ ] **Step 3: implement**

```ts
// src/core/contracts.ts — SendInputSchema gains:
ackThrough: z.number().int().positive().optional(),
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

Add `ackedThrough?: number` to `EventFields` (and to the emitted event type if it is
constrained where it is defined).

- [ ] **Step 4: failing HTTP contract test** — in `src/http/app.test.ts`, per that file's
  existing send test: POST send with `ackThrough` included → 200 and the sender's subsequent
  inbox is empty. Run — fails. Implement: nothing (schema shared) — it should pass once
  Step 3 lands; if it fails, the surface is not reusing the core schema — fix that, do not
  duplicate the field.

- [ ] **Step 5: CLI flag**

```ts
// src/cli/index.ts — send command gains:
.option('--ack-through <id>', 'ack your inbox through this message id in the same round')
```

Thread both paths through (`ackThrough: o.ackThrough !== undefined ? Number(o.ackThrough) : undefined`),
and give `sendTo` an optional `ackThrough` parameter it forwards to `c.send`. Add one
`commands.test.ts` case per that file's fake-client conventions proving `sendTo` forwards it.

- [ ] **Step 6: MCP description** (schema already flows): send tool description becomes
  `'Send a message into an existing thread (reopens an ended thread). Pass ackThrough to also ack your inbox through that id — reply+ack in one call.'`

- [ ] **Step 7: full suite green. Commit:**

```bash
git add src/core/contracts.ts src/core/service.ts src/core/service.delivery.test.ts src/http/app.test.ts src/cli/index.ts src/cli/commands.ts src/cli/commands.test.ts src/mcp/tools.ts
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
