# Increment 5 — MCP ergonomics: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Implementers MUST invoke `superpowers:test-driven-development` and follow the repo Testing Methodology (behavior through public interfaces; a behavior-preserving refactor must never break tests).

**Goal:** One MCP call per task: `send.to` (core), ack-on-listen, `snapshot`, server instructions, result hints, annotations, compact output.

**Branch:** `feat/ffl-5-mcp-ergonomics`

---

### Task 1: core — `send` accepts `to` XOR `threadId`

**Files:**
- Modify: `src/core/contracts.ts` (SendInputSchema), `src/core/service.ts` (send + private resolution)
- Test: `src/core/service.delivery.test.ts` (or lifecycle file if thread-reopen tests live there — follow the existing split)

- [ ] **Step 1: failing core tests** (use the real `twoAgents()` fixtures):

```ts
it('send with to resolves the open thread with that peer', async () => {
  const h = twoAgents()
  const { thread } = await h.service.call(gha, { to: 'volumi', subject: 's', body: 'm1' })
  const res = await h.service.send(vol, { to: 'gha-docker-runner', body: 'reply' })
  expect(res.message.threadId).toBe(thread.id)
})

it('send with to reopens the most recently ended thread with that peer', async () => {
  const h = twoAgents()
  const t1 = await h.service.call(gha, { to: 'volumi', subject: 'a', body: 'x' })
  await h.service.hangup(gha, { threadId: t1.thread.id })
  const res = await h.service.send(gha, { to: 'volumi', body: 'late reply' })
  expect(res.message.threadId).toBe(t1.thread.id)
  const threads = await h.service.threads(gha, { status: 'open' })
  expect(threads.threads.map((t) => t.id)).toContain(t1.thread.id) // reopen-on-send
})

it('send with to and no thread history is NOT_FOUND steering to call', async () => {
  const h = twoAgents()
  await expect(h.service.send(gha, { to: 'volumi', body: 'hi' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
})

it('send requires exactly one of threadId and to', async () => {
  // schema-level: both and neither must fail parse
  expect(() => SendInputSchema.parse({ body: 'x' })).toThrow()
  expect(() => SendInputSchema.parse({ body: 'x', threadId: 1, to: 'volumi' })).toThrow()
})
```

(Adapt ctx names to the file's real fixtures. If multiple ended threads exist with the peer,
most-recent by `lastActivityAt` wins — add that arrangement to the reopen test.)

- [ ] **Step 2: run — fails** (schema rejects `to`; service has no resolution)

- [ ] **Step 3: implement**

```ts
// contracts.ts — SendInputSchema becomes (keep ackThrough as-is):
export const SendInputSchema = z
  .object({
    threadId: z.number().int().positive().optional(),
    to: z.string().min(1).optional(),
    body: BodySchema,
    ackThrough: z.number().int().positive().optional(),
  })
  .refine((v) => (v.threadId === undefined) !== (v.to === undefined), {
    message: 'pass exactly one of threadId or to',
  })
```

NOTE: the HTTP send route parses `SendInputSchema.omit({ threadId: true })` — `.omit` does
not exist on a ZodEffects (refined) schema. Restructure: export the inner object as
`SendFieldsSchema` (object, omittable) and `SendInputSchema` as the refined version; the
HTTP route parses `SendFieldsSchema.omit({ threadId: true, to: true })` and keeps its
path-param threadId (route sends stay threadId-addressed; `to` reaches HTTP via the same
body field — decide: simplest is route parses `SendFieldsSchema.omit({ threadId: true })`
so body may carry `to`… but the route ALREADY has a threadId from the path — reject `to`
in the route body (`.strict()` behavior today?) — implementer: verify current omit+parse
behavior and keep the route contract EXACTLY as-is (path threadId, no `to` in body); the
`to` form enters over HTTP through MCP only. Document the decision in impl.md.)

```ts
// service.ts — inside send(), replace the requireParticipant line:
const thread =
  input.threadId !== undefined
    ? this.requireParticipant(input.threadId, ctx.agent)
    : this.resolvePeerThread(input.to as string, ctx.agent)
```

```ts
// service.ts — private helper (mirror the CLI's contract, server-side):
private resolvePeerThread(peer: string, agent: string): ThreadRecord {
  const mine = this.store
    .listThreadsFor(agent)
    .filter((t) => t.participantA === peer || t.participantB === peer)
  const open = mine.filter((t) => t.status === 'open')
  const pool = open.length > 0 ? open : mine
  const best = pool.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
  if (!best) {
    throw new PhoneError('NOT_FOUND', `no thread with "${peer}" - open one with call`)
  }
  return best
}
```

- [ ] **Step 4: green + full suite. Commit** `feat(core): send accepts to as an alternative to threadId - server-side peer thread resolution`

### Task 2: CLI/client ride the core resolution

**Files:** `src/client/client.ts` (send already forwards SendInput — verify `to` serializes; it posts to `/api/calls/:threadId/messages` which REQUIRES threadId!), `src/cli/commands.ts` (`sendTo`), `src/cli/commands.test.ts`.

Reality check for the implementer: `PhoneClient.send` addresses the route by
`input.threadId` — a `to`-send has no threadId. Options, pick the one the plan-review gate
approved: **client sends `to` via MCP-style body is NOT available over REST; instead
`PhoneClient` gains `sendTo(to, body, ackThrough?)` that POSTs to a NEW route** — NO. Route
changes are a non-goal. Correct resolution: keep `PhoneClient.send` threadId-only; rewrite
CLI `sendTo` to call a new `PhoneClient` method that uses the EXISTING threads listing ONCE
(`threads('all')` → same resolution as core, client-side single extra round) — also NO
(that's today's shape).

**Decision (locked by design.md G2):** add ONE new REST route `POST /api/messages` that
parses the full refined `SendInputSchema` (threadId XOR to) and calls `service.send`
unchanged — a thin second entry to the same core verb, keeping `/api/calls/:id/messages`
untouched. `PhoneClient.send` switches to `POST /api/messages` with the full input.
`sendTo` in commands.ts becomes `client.send({ to, body, ackThrough })`. Existing
`commands.test.ts` fake-client tests keep their meaning (sendTo forwards); the
`resolvePeerThread` client function and its tests are DELETED (contract moved to core —
covered by Task 1 tests).

- [ ] Red: `client.test.ts` round-trip — `b.send({ to: 'a', body: 'x' })` lands in a's inbox (fails: no route). Implement route (label `'send'`, same event shape — resolution happens in core so `ev.threadId` is stamped as today), flip `PhoneClient.send`, thin `sendTo`, delete dead client resolution + its tests.
- [ ] Full suite + gates green. Commit `feat(http,cli): send-by-peer over one round - unified /api/messages route, cli rides core resolution`

### Task 3: MCP — instructions, snapshot, ack option, hints, annotations, compact

**Files:** `src/mcp/tools.ts`; Test: `test/mcp.test.ts` (extend the existing stateless round-trip harness).

- [ ] Red tests (through `handleMcpRequest`, real JSON-RPC):
  - initialize result carries `instructions` containing "listen WAITS" (substring pin, not full text).
  - `tools/call snapshot` → JSON with `agents`, `threads`, `messages`, `cursor` keys.
  - `tools/call listen {waitMs:0, ack:true}` after a seeded message → delivered AND a
    subsequent `inbox` shows empty.
  - `tools/list` → phonebook/inbox/history/threads/snapshot carry
    `annotations.readOnlyHint === true`.
- [ ] Implement:

```ts
const INSTRUCTIONS = `trunkline connects agents on different machines. Economics: every tool
call costs you a full think-act cycle; the server is milliseconds. Rules:
1. listen WAITS up to waitMs for NEW unacked messages - to read what exists, use inbox
   (peek) or history. For a background ring between turns, use the trunkline CLI.
2. Reply and ack in ONE call: send {to: "<peer>", body, ackThrough: <cursor>} - to is the
   peer name; no threads lookup needed.
3. snapshot = phonebook + open threads + unacked inbox in one call - the "what's my state" opener.
4. Messages redeliver until acked; ack with listen/inbox {ack:true} or send.ackThrough.`

const server = new McpServer({ name: 'trunkline', version: '0.1.0' }, { instructions: INSTRUCTIONS })
```

  - `text()` drops pretty-print: `JSON.stringify(data)`.
  - listen/inbox handlers: `inputSchema` gains `ack: z.boolean().default(false)`; after
    `service.listen`, if `ack && result.messages.length > 0` call
    `service.ack(ctx, { throughMessageId: result.cursor })` (two ops → two canonical events,
    same as CLI `--ack`); append `hint` to the returned object:
    `reply+ack in one call: send {to, body, ackThrough: ${result.cursor}}` (only when
    messages were delivered and not auto-acked; when auto-acked: hint that the reply is just
    `send {to, body}`).
  - `snapshot` tool (annotations readOnlyHint): composes `service.phonebook`,
    `service.threads(status:'open')`, `service.listen({waitMs:0})` → `{ agents, threads, messages, cursor }`.
  - annotations: `{ readOnlyHint: true }` on phonebook/inbox/history/threads/snapshot;
    `{ idempotentHint: true }` on ack.
  - send tool: schema now the refined XOR — `registerTool` needs `.shape` of the INNER
    object (`SendFieldsSchema.shape`) since ZodEffects has no `.shape`; the XOR is enforced
    by core when the service parses/receives input — MCP passes through; description updated
    to lead with the `to` form.
- [ ] Full suite + gates. Commit `feat(mcp): instructions, snapshot, ack-on-listen, hints, annotations, compact results`

### Task 4: verification + evidence

- [ ] All gates (direct commands).
- [ ] Deploy to the live container (`docker compose up -d --build`) — post-increment-4 muscle
  memory: volume/data untouched, this is a code-only rebuild; health + `admin list` intact.
- [ ] AC6 measurement: headless `claude -p` against the live MCP — prompt it to check state
  and reply+ack to a seeded message; count tool calls in the session transcript (expect: 1–2
  vs the 3–4 baseline); record wall-clock. Store evidence + method in impl.md.
- [ ] impl.md (decisions, deviations, evidence). PR per process; merge `--rebase` on green.
