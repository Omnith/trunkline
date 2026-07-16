import { describe, expect, test } from 'vitest'
import { makeService, provision } from '../testkit/harness.js'

const gha = { agent: 'gha-docker-runner', surface: 'http' as const }
const vol = { agent: 'volumi', surface: 'http' as const }

function twoAgents() {
  const h = makeService()
  provision(h, 'gha-docker-runner')
  provision(h, 'volumi')
  return h
}

describe('call', () => {
  test('creates an open thread and delivers the optional first message', async () => {
    const h = twoAgents()
    const out = await h.service.call(gha, { to: 'volumi', subject: 'ci retries', body: 'hello' })
    expect(out.thread.status).toBe('open')
    expect(out.message?.recipient).toBe('volumi')
    const inbox = await h.service.listen(vol, { waitMs: 0 })
    expect(inbox.messages.map((m) => m.body)).toEqual(['hello'])
  })

  test('calling an unknown agent is NOT_FOUND; calling yourself is VALIDATION_ERROR', async () => {
    const h = twoAgents()
    await expect(h.service.call(gha, { to: 'nobody', subject: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      h.service.call(gha, { to: 'gha-docker-runner', subject: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('send', () => {
  test('a non-participant cannot send into a thread', async () => {
    const h = twoAgents()
    provision(h, 'intruder')
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'private' })
    await expect(
      h.service.send({ agent: 'intruder', surface: 'http' }, { threadId: thread.id, body: 'hi' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  test('send with ackThrough advances the sender cursor with ack semantics and still delivers', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 's', body: 'm1' })
    await h.service.send(gha, { threadId: thread.id, body: 'm2' })

    const before = await h.service.listen(vol, { waitMs: 0 })
    expect(before.messages.length).toBe(2)

    const res = await h.service.send(vol, {
      threadId: thread.id,
      body: 'reply',
      ackThrough: before.cursor,
    })
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

    // canonical wide event carries the piggyback (observability contract)
    const ev = h.emitter.events.find((e) => e.op === 'send' && e.ackedThrough !== undefined)
    expect(ev?.ackedThrough).toBe(before.cursor)
  })
})

describe('send by peer (to)', () => {
  test('send with to resolves the open thread with that peer, ignoring other peers', async () => {
    const h = twoAgents()
    provision(h, 'bystander')
    const other = await h.service.call(gha, { to: 'bystander', subject: 'noise', body: 'n' })
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 's', body: 'm1' })
    const res = await h.service.send(vol, { to: 'gha-docker-runner', body: 'reply' })
    expect(res.message.threadId).toBe(thread.id)
    expect(res.message.threadId).not.toBe(other.thread.id)
  })

  test('send with to reopens the most recently ended thread with that peer', async () => {
    const h = twoAgents()
    const older = await h.service.call(gha, { to: 'volumi', subject: 'old', body: 'w' })
    await h.service.hangup(gha, { threadId: older.thread.id })
    h.clock.advance(1000)
    const t1 = await h.service.call(gha, { to: 'volumi', subject: 'a', body: 'x' })
    await h.service.hangup(gha, { threadId: t1.thread.id })
    const res = await h.service.send(gha, { to: 'volumi', body: 'late reply' })
    expect(res.message.threadId).toBe(t1.thread.id) // most recent of the two ended
    const threads = await h.service.threads(gha, { status: 'open' })
    expect(threads.threads.map((t) => t.id)).toContain(t1.thread.id) // reopen-on-send
  })

  test('send with to and multiple open threads with that peer is AMBIGUOUS_THREAD listing ids', async () => {
    const h = twoAgents()
    const a = await h.service.call(gha, { to: 'volumi', subject: 'a', body: 'x' })
    const b = await h.service.call(gha, { to: 'volumi', subject: 'b', body: 'y' })
    await expect(h.service.send(gha, { to: 'volumi', body: 'which?' })).rejects.toMatchObject({
      code: 'AMBIGUOUS_THREAD',
      message: expect.stringContaining(`#${a.thread.id}`),
    })
    void b
  })

  test('an open thread idle past the TTL does not count as open for resolution', async () => {
    const h = twoAgents()
    const stale = await h.service.call(gha, { to: 'volumi', subject: 'old', body: 'x' })
    h.clock.advance(25 * 60 * 60 * 1000) // past the 24h TTL
    const fresh = await h.service.call(gha, { to: 'volumi', subject: 'new', body: 'y' })
    const res = await h.service.send(gha, { to: 'volumi', body: 'r' }) // NOT ambiguous
    expect(res.message.threadId).toBe(fresh.thread.id)
    void stale
  })

  test('send with to and no thread history is NOT_FOUND steering to call', async () => {
    const h = twoAgents()
    await expect(h.service.send(gha, { to: 'volumi', body: 'hi' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('call'),
    })
  })

  test('send to yourself is rejected', async () => {
    const h = twoAgents()
    await expect(
      h.service.send(gha, { to: 'gha-docker-runner', body: 'hi me' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  test('send requires exactly one of threadId and to (enforced in core, all surfaces)', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 's', body: 'm' })
    await expect(h.service.send(gha, { body: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await expect(
      h.service.send(gha, { threadId: thread.id, to: 'volumi', body: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('at-least-once delivery', () => {
  test('unacked messages are re-delivered until acked; ack stops redelivery', async () => {
    const h = twoAgents()
    await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'important' })
    const first = await h.service.listen(vol, { waitMs: 0 })
    const second = await h.service.listen(vol, { waitMs: 0 })
    expect(first.messages).toEqual(second.messages) // no silent consumption
    await h.service.ack(vol, { throughMessageId: second.cursor })
    const third = await h.service.listen(vol, { waitMs: 0 })
    expect(third.messages).toEqual([])
  })

  test('ack is idempotent, never regresses, and caps at the max message id', async () => {
    const h = twoAgents()
    await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'm1' })
    const { cursor } = await h.service.listen(vol, { waitMs: 0 })
    const acked = await h.service.ack(vol, { throughMessageId: cursor })
    expect(acked.ackedThroughMessageId).toBe(cursor)
    expect((await h.service.ack(vol, { throughMessageId: 0 })).ackedThroughMessageId).toBe(cursor)
    expect((await h.service.ack(vol, { throughMessageId: 999_999 })).ackedThroughMessageId).toBe(
      h.store.maxMessageId(),
    )
  })
})

describe('listen long-poll', () => {
  test('returns immediately when unacked messages already exist', async () => {
    const h = twoAgents()
    await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'waiting for you' })
    const out = await h.service.listen(vol, { waitMs: 5000 })
    expect(out.messages).toHaveLength(1)
    const ev = h.emitter.events.find((e) => e.op === 'listen')
    expect(ev?.deliveredCount).toBe(1)
  })

  test('parks until a send wakes it', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci' })
    const parked = h.service.listen(vol, { waitMs: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    await h.service.send(gha, { threadId: thread.id, body: 'ping' })
    const out = await parked
    expect(out.messages.map((m) => m.body)).toEqual(['ping'])
  })

  test('times out empty when nothing arrives, leaving the cursor unchanged', async () => {
    const h = twoAgents()
    const before = h.store.getCursor('volumi')
    const out = await h.service.listen(vol, { waitMs: 150 })
    expect(out.messages).toEqual([])
    expect(out.cursor).toBe(before)
  })

  test('a single listen delivers at most 500 messages; the remainder arrives after ack', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'flood' })
    for (let i = 1; i <= 501; i++) {
      await h.service.send(gha, { threadId: thread.id, body: `m${i}` })
    }
    const first = await h.service.listen(vol, { waitMs: 0 })
    expect(first.messages).toHaveLength(500)
    expect(first.messages.at(-1)?.body).toBe('m500')
    expect(first.cursor).toBe(first.messages.at(-1)?.id)
    await h.service.ack(vol, { throughMessageId: first.cursor })
    const second = await h.service.listen(vol, { waitMs: 0 })
    expect(second.messages.map((m) => m.body)).toEqual(['m501'])
  })

  test('phonebook reports listening=true while a listen is parked', async () => {
    const h = twoAgents()
    const parked = h.service.listen(vol, { waitMs: 400 })
    await new Promise((r) => setTimeout(r, 50))
    const book = await h.service.phonebook(gha)
    expect(book.agents.find((a) => a.name === 'volumi')?.listening).toBe(true)
    await parked
    const after = await h.service.phonebook(gha)
    expect(after.agents.find((a) => a.name === 'volumi')?.listening).toBe(false)
  })
})

describe('graceful shutdown', () => {
  test('releaseWaiters resolves an in-flight listen empty instead of re-parking', async () => {
    const h = twoAgents()
    const parked = h.service.listen(gha, { waitMs: 60_000 })
    await new Promise((r) => setTimeout(r, 20)) // let it park
    h.service.releaseWaiters()
    const res = await parked // must resolve now, not after 60s
    expect(res.messages).toEqual([])
  })
})

describe('canonical events', () => {
  test('every operation emits exactly one event, including failures', async () => {
    const h = twoAgents()
    h.emitter.events.length = 0
    await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'm1' })
    await h.service.listen(vol, { waitMs: 0 })
    await h.service.ack(vol, { throughMessageId: 1 })
    await h.service.call(gha, { to: 'nobody', subject: 'x' }).catch(() => undefined)
    const ops = h.emitter.events.map((e) => `${e.op}:${e.outcome}`)
    expect(ops).toEqual(['call:ok', 'listen:ok', 'ack:ok', 'call:error'])
  })
})
