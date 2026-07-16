# Increment 5 — MCP ergonomics: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Implementers MUST invoke `superpowers:test-driven-development` and follow the repo Testing Methodology (behavior through public interfaces; a behavior-preserving refactor must never break tests).

**Goal:** One MCP call per task: `send.to` (core), ack-on-listen, `snapshot`, server instructions, result hints, annotations, compact output.

**Branch:** `feat/ffl-5-mcp-ergonomics`

---

> **Plan rev 2 (gate findings folded in):** `SendInputSchema` STAYS a plain zod object (both
> `threadId` and `to` optional) so every existing `.omit`/`.shape` consumer keeps compiling —
> there is NO refined/ZodEffects schema anywhere. The XOR invariant is enforced ONCE, in
> `service.send` (a schema refine would be silently dropped on the MCP surface, where the SDK
> re-wraps `.shape`). The CLI's ambiguity guard is PRESERVED in core, TTL-aware.

### Task 1: core — `send` accepts `to` XOR `threadId`

**Files:**
- Modify: `src/core/contracts.ts` (SendInputSchema fields), `src/core/errors.ts` (code union gains `AMBIGUOUS_THREAD`), `src/http/app.ts` (status map: `AMBIGUOUS_THREAD` → 409), `src/core/service.ts` (send guard + private resolution)
- Test: `src/core/service.delivery.test.ts` (or lifecycle file if thread-reopen tests live there — follow the existing split)

Note: adding `to` to the shared schema means the MCP send tool accepts it from this task
onward (via `.shape`) with the core guard enforcing the XOR — that is correct and green.

- [ ] **Step 1: failing core tests** (use the real `twoAgents()` fixtures — it registers
  `gha-docker-runner` and `volumi`; ctxs per the file's conventions):

```ts
it('send with to resolves the open thread with that peer, ignoring other peers', async () => {
  const h = twoAgents() // plus provision a third agent 'bystander' per the harness helpers
  const other = await h.service.call(gha, { to: 'bystander', subject: 'noise', body: 'n' })
  const { thread } = await h.service.call(gha, { to: 'volumi', subject: 's', body: 'm1' })
  const res = await h.service.send(vol, { to: 'gha-docker-runner', body: 'reply' })
  expect(res.message.threadId).toBe(thread.id)
  expect(res.message.threadId).not.toBe(other.thread.id)
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

it('send with to and multiple open threads with that peer is AMBIGUOUS_THREAD listing ids', async () => {
  const h = twoAgents()
  const a = await h.service.call(gha, { to: 'volumi', subject: 'a', body: 'x' })
  const b = await h.service.call(gha, { to: 'volumi', subject: 'b', body: 'y' })
  await expect(h.service.send(gha, { to: 'volumi', body: 'which?' })).rejects.toMatchObject({
    code: 'AMBIGUOUS_THREAD',
    message: expect.stringContaining(`#${a.thread.id}`),
  })
  void b
})

it('an open thread idle past the TTL does not count as open for resolution', async () => {
  const h = twoAgents()
  const stale = await h.service.call(gha, { to: 'volumi', subject: 'old', body: 'x' })
  h.clock.advance(25 * 60 * 60 * 1000) // past the 24h TTL (use the harness clock helper)
  const fresh = await h.service.call(gha, { to: 'volumi', subject: 'new', body: 'y' })
  const res = await h.service.send(gha, { to: 'volumi', body: 'r' }) // NOT ambiguous
  expect(res.message.threadId).toBe(fresh.thread.id)
  void stale
})

it('send with to and no thread history is NOT_FOUND steering to call', async () => {
  const h = twoAgents()
  await expect(h.service.send(gha, { to: 'volumi', body: 'hi' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: expect.stringContaining('call'),
  })
})

it('send to yourself is rejected', async () => {
  const h = twoAgents()
  await expect(
    h.service.send(gha, { to: 'gha-docker-runner', body: 'hi me' }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
})

it('send requires exactly one of threadId and to (enforced in core, all surfaces)', async () => {
  const h = twoAgents()
  const { thread } = await h.service.call(gha, { to: 'volumi', subject: 's', body: 'm' })
  await expect(h.service.send(gha, { body: 'x' })).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  })
  await expect(
    h.service.send(gha, { threadId: thread.id, to: 'volumi', body: 'x' }),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
})
```

(Adapt fixture/helper names to the file's reality — e.g. how a third agent is provisioned
and how the fake clock advances. Behavior assertions stay exactly as above.)

- [ ] **Step 2: run — fails** (schema strips `to`; service has no guard/resolution)

- [ ] **Step 3: implement**

```ts
// contracts.ts — SendInputSchema STAYS a plain object (all .omit/.shape consumers unchanged):
export const SendInputSchema = z.object({
  threadId: z.number().int().positive().optional(),
  to: AgentNameSchema.optional(), // reuse the existing name schema
  body: BodySchema,
  ackThrough: z.number().int().positive().optional(),
})
```

```ts
// errors.ts — PhoneError code union gains 'AMBIGUOUS_THREAD'
// http/app.ts — the PhoneError→status map gains AMBIGUOUS_THREAD: 409
```

```ts
// service.ts — top of send()'s op callback (the ONE enforcement point for every surface;
// a schema refine would be dropped by the MCP SDK's .shape re-wrap):
if ((input.threadId === undefined) === (input.to === undefined)) {
  throw new PhoneError('VALIDATION_ERROR', 'pass exactly one of threadId or to')
}
if (input.to === ctx.agent) {
  throw new PhoneError('VALIDATION_ERROR', 'cannot send to yourself')
}
const thread =
  input.threadId !== undefined
    ? this.requireParticipant(input.threadId, ctx.agent)
    : this.resolvePeerThread(input.to as string, ctx.agent)
```

```ts
// service.ts — private helper. TTL-aware like every other read path (effectiveStatus),
// ambiguity guard preserved from the CLI contract, store ordering
// (lastActivityAt DESC, id DESC) relied upon — no re-sort:
private resolvePeerThread(peer: string, agent: string): ThreadRecord {
  const mine = this.store
    .listThreadsFor(agent)
    .filter((t) => t.participantA === peer || t.participantB === peer)
  const open = mine.filter((t) => this.effectiveStatus(t) === 'open')
  if (open.length > 1) {
    const ids = open.map((t) => `#${t.id}`).join(', ')
    throw new PhoneError(
      'AMBIGUOUS_THREAD',
      `multiple open threads with "${peer}" (${ids}) - pass threadId`,
    )
  }
  const best = open[0] ?? mine[0] // mine is lastActivityAt DESC: latest ended wins
  if (!best) {
    throw new PhoneError('NOT_FOUND', `no thread with "${peer}" - open one with call`)
  }
  return best
}
```

(Adapt `effectiveStatus` usage to its real signature in service.ts.)

- [ ] **Step 4: green + full suite (app.ts `.omit` and mcp `.shape` keep compiling — the
  schema stayed an object). Commit** `feat(core): send accepts to as an alternative to threadId - server-side peer thread resolution`

### Task 2: CLI/client ride the core resolution

**Files:** `src/client/client.ts` (send already forwards SendInput — verify `to` serializes; it posts to `/api/calls/:threadId/messages` which REQUIRES threadId!), `src/cli/commands.ts` (`sendTo`), `src/cli/commands.test.ts`.

**Decisions (locked by the plan-review gate):**

- ONE new REST route `POST /api/messages` parsing the full `SendInputSchema` (plain object;
  the XOR/self-send guards live in core and surface as `VALIDATION_ERROR` → 422-class, same
  as everywhere). Label `'send'` — same core verb, same event shape (`ev.threadId` stamped
  after resolution).
- The existing path route `/api/calls/:id/messages` parses
  `SendInputSchema.omit({ threadId: true, to: true })` — a stray body `to` is stripped
  exactly as unknown keys are today; the path `threadId` stays authoritative. `to` enters
  HTTP ONLY via `/api/messages`. Stated as contract, not implementer judgment.
- `PhoneClient.send` switches to `POST /api/messages` with the full input (all three
  existing round-trip tests stay green: threadId form satisfies the guard; `threadId: 999`
  still NOT_FOUND).
- `sendTo` in commands.ts becomes a thin `client.send({ to, body, ackThrough })`. The
  existing `sendTo` fake-client tests are **REWRITTEN, not kept**: `SendToClient` loses
  `threads()`, assertions become `{ to, body, ackThrough }` forwarding (one case with
  ackThrough, one without). The client-side `resolvePeerThread` function and its tests are
  DELETED — every behavior they pinned now lives in Task 1's core tests (open-thread
  resolution, other-peer exclusion, ended-reopen, AMBIGUOUS on multiple opens, NOT_FOUND
  steering message).

- [ ] Red: `client.test.ts` round-trip using the real fixture names — gha `call`s volumi to
  establish the thread, then `volClient.send({ to: 'gha-docker-runner', body: 'x' })` lands
  in gha's inbox (fails: no route). Implement route, flip `PhoneClient.send`, thin `sendTo`,
  rewrite/delete tests as above.
- [ ] Note in impl.md: the path route keeps working but loses direct client exercise once
  PhoneClient switches — keep ONE direct raw-fetch test of `/api/calls/:id/messages` (201 +
  delivery) so the retained route stays pinned.
- [ ] Full suite + gates green. Commit `feat(http,cli): send-by-peer over one round - unified /api/messages route, cli rides core resolution`

### Task 3: MCP — instructions, snapshot, ack option, hints, annotations, compact

**Files:** `src/mcp/tools.ts`; Test: `test/mcp.test.ts` (extend the existing stateless round-trip harness).

**Rev 2 scope corrections:** `ack` goes on **listen ONLY** — `inbox` stays a pure peek so its
`readOnlyHint: true` is honest (a cursor-advancing option under a read-only label would let
annotation-honoring harnesses mutate ungated). The existing `mcp.test.ts` "lists the ten
verbs" assertion (exact sorted name set) MUST be extended to eleven with `snapshot`.

- [ ] Red tests (extend the existing `mcp.test.ts` harness — it connects via the SDK
  `Client`; use its established helpers):
  - instructions: `client.getInstructions()` contains `'listen WAITS'` (substring pin).
  - `tools/call snapshot` → JSON with `agents`, `threads`, `messages`, `cursor` keys.
  - listen-ack arrangement: gha `call`s volumi (seeds volumi's inbox) → volumi
    `listen {waitMs: 0, ack: true}` delivers → volumi `inbox` → empty. Default
    (`ack` omitted) still leaves messages unacked.
  - `tools/list` → phonebook/inbox/history/threads/snapshot carry
    `annotations.readOnlyHint === true`; the verb-set assertion now expects eleven names.
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
  - `listen` handler ONLY: `inputSchema` gains `ack: z.boolean().default(false)`; after
    `service.listen`, if `ack && result.messages.length > 0` call
    `service.ack(ctx, { throughMessageId: result.cursor })` (two ops → two canonical events,
    same as CLI `--ack`); append `hint` to the returned object — delivered & not auto-acked:
    `reply+ack in one call: send {to, body, ackThrough: ${result.cursor}}`; delivered &
    auto-acked: `reply with send {to, body}`. `inbox` handler: unchanged semantics, plus the
    same not-auto-acked hint when messages exist.
  - `snapshot` tool: composes `service.phonebook`, `service.threads(status:'open')`,
    `service.listen({waitMs:0})` → `{ agents, threads, messages, cursor }` (peek — does not
    advance the cursor; three canonical sub-events, no snapshot-level event — note the
    observability choice in impl.md).
  - annotations: `{ readOnlyHint: true }` on phonebook/inbox/history/threads/snapshot;
    `{ idempotentHint: true }` on ack.
  - send tool: `SendInputSchema.shape` continues to work (schema stayed an object and now
    carries `to` — the XOR/self-send guards enforce in core and surface via `wrap()` as
    isError results); description updated to lead with the `to` form.
- [ ] Full suite + gates. Commit `feat(mcp): instructions, snapshot, ack-on-listen, hints, annotations, compact results`

### Task 4: verification + evidence

- [ ] All gates (direct commands).
- [ ] Deploy to the live container (`docker compose up -d --build`) — post-increment-4 muscle
  memory: volume/data untouched, this is a code-only rebuild; health + `admin list` intact.
- [ ] AC6 measurement, two layers:
  - **Primary (deterministic):** through the mcp test harness (or a scratchpad script
    against the live server), complete the canonical exchange with counted `tools/call`s —
    state check = `snapshot` (1 call, was `phonebook`+`threads`+`inbox` = 3); reply+ack =
    `send {to, body, ackThrough}` (1 call, was `threads`+`send {threadId}`+`ack` = 3;
    baseline by construction from the pre-increment tool set).
  - **Secondary (realism):** one headless `claude -p --output-format json` run against the
    live MCP with a fixed prompt ("check the phone state, then reply X to volumi and ack"),
    counting tool_use blocks in its transcript jsonl; note model/run variance — evidence,
    not a gate.
  Record both in impl.md.
- [ ] impl.md (decisions, deviations, evidence). PR per process; merge `--rebase` on green.
