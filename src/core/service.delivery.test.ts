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
