import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { JsonlEmitter } from '../obs/emitters.js'
import { makeService, provision } from '../testkit/harness.js'
import type { PhoneEvent } from './ports.js'

const HOUR = 3600_000
const gha = { agent: 'gha-docker-runner', surface: 'http' as const }
const vol = { agent: 'volumi', surface: 'http' as const }

function twoAgents() {
  const h = makeService()
  provision(h, 'gha-docker-runner')
  provision(h, 'volumi')
  return h
}

describe('hangup', () => {
  test('ends the thread and delivers the note as a system message', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci' })
    const out = await h.service.hangup(gha, { threadId: thread.id, note: 'all fixed, thanks' })
    expect(out.thread.status).toBe('ended')
    expect(out.thread.endedBy).toBe('gha-docker-runner')
    const inbox = await h.service.listen(vol, { waitMs: 0 })
    expect(inbox.messages.at(-1)).toMatchObject({ kind: 'system', body: 'all fixed, thanks' })
  })
})

describe('threads + reopen-on-send', () => {
  test('sending to an ended thread reopens it', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci' })
    await h.service.hangup(gha, { threadId: thread.id })
    expect((await h.service.threads(gha, { status: 'ended' })).threads.map((t) => t.id)).toEqual([
      thread.id,
    ])
    await h.service.send(vol, { threadId: thread.id, body: 'one more thing' })
    expect((await h.service.threads(gha, { status: 'open' })).threads.map((t) => t.id)).toEqual([
      thread.id,
    ])
  })

  test('an idle open thread reads as ended after the TTL and revives on send', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci' })
    h.clock.advance(24 * HOUR + 1)
    expect((await h.service.threads(gha, { status: 'open' })).threads).toEqual([])
    expect((await h.service.threads(gha, { status: 'ended' })).threads.map((t) => t.id)).toEqual([
      thread.id,
    ])
    await h.service.send(gha, { threadId: thread.id, body: 'still there?' })
    expect((await h.service.threads(gha, { status: 'open' })).threads.map((t) => t.id)).toEqual([
      thread.id,
    ])
  })
})

describe('history', () => {
  test('pages by afterId and rejects non-participants', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'm1' })
    await h.service.send(vol, { threadId: thread.id, body: 'm2' })
    await h.service.send(gha, { threadId: thread.id, body: 'm3' })
    const all = await h.service.history(gha, { threadId: thread.id, afterId: 0, limit: 100 })
    expect(all.messages.map((m) => m.body)).toEqual(['m1', 'm2', 'm3'])
    const firstId = all.messages[0]?.id ?? 0
    const rest = await h.service.history(gha, { threadId: thread.id, afterId: firstId, limit: 100 })
    expect(rest.messages.map((m) => m.body)).toEqual(['m2', 'm3'])
    provision(h, 'intruder')
    await expect(
      h.service.history(
        { agent: 'intruder', surface: 'http' },
        { threadId: thread.id, afterId: 0, limit: 100 },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('JsonlEmitter', () => {
  test('writes one JSON line per event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trunkline-'))
    const path = join(dir, 'events.jsonl')
    const emitter = new JsonlEmitter(path)
    const event: PhoneEvent = {
      ts: 1,
      op: 'call',
      surface: 'http',
      agent: 'volumi',
      outcome: 'ok',
      durationMs: 2,
    }
    emitter.emit(event)
    emitter.emit({ ...event, op: 'ack' })
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ op: 'call' })
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ op: 'ack' })
  })
})
