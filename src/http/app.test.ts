import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { invite, makeService, provision, type Harness } from '../testkit/harness.js'
import { buildApp } from './app.js'

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function boot(h: Harness): Promise<string> {
  const app = buildApp({ service: h.service, emitter: h.emitter, clock: h.clock })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server?.address()
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port')
  return `http://127.0.0.1:${addr.port}`
}

const asJson = (r: Response): Promise<unknown> => r.json() as Promise<unknown>

describe('http surface', () => {
  test('health is public; everything else requires a valid bearer token', async () => {
    const h = makeService()
    const base = await boot(h)
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/agents`)).status).toBe(401)
    const bad = await fetch(`${base}/api/agents`, { headers: { authorization: 'Bearer nope' } })
    expect(bad.status).toBe(401)
    expect(await asJson(bad)).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  test('the bearer scheme is matched case-insensitively', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/agents`, {
      headers: { authorization: `bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  test('an unmatched route returns a JSON 404 with the standard error shape', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/bogus`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
    expect(await asJson(res)).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  test('register over http mints a token that then authenticates', async () => {
    const h = makeService()
    const code = invite(h)
    const base = await boot(h)
    const res = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'volumi', inviteCode: code }),
    })
    expect(res.status).toBe(201)
    const { token } = (await asJson(res)) as { token: string }
    const agents = await fetch(`${base}/api/agents`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(agents.status).toBe(200)
  })

  test('validation failures return 422 with the single error shape AND emit one canonical event', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    h.emitter.events.length = 0
    const res = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: 'volumi' }), // missing subject
    })
    expect(res.status).toBe(422)
    expect(await asJson(res)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    const boundary = h.emitter.events.filter((e) => e.outcome === 'error')
    expect(boundary).toHaveLength(1)
    expect(boundary[0]).toMatchObject({
      op: 'call',
      errorCode: 'VALIDATION_ERROR',
      agent: 'volumi',
    })
  })

  test('a body over the 64KB message cap is rejected with 422', async () => {
    const h = makeService()
    provision(h, 'gha-docker-runner')
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: 'gha-docker-runner',
        subject: 'big',
        body: 'x'.repeat(64 * 1024 + 1),
      }),
    })
    expect(res.status).toBe(422)
  })

  test('a payload beyond the transport limit maps to 413, not 500', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: 'volumi', subject: 'big', body: 'x'.repeat(300 * 1024) }),
    })
    expect(res.status).toBe(413)
    expect(await asJson(res)).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
  })

  test('domain errors map to their statuses (404 unknown thread)', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/calls/999/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: 'hi' }),
    })
    expect(res.status).toBe(404)
    expect(await asJson(res)).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  test('POST /api/calls/:id/messages sends into the path thread (201) and delivers', async () => {
    const h = makeService()
    const ghaToken = provision(h, 'gha-docker-runner')
    const volToken = provision(h, 'volumi')
    const base = await boot(h)
    const auth = (t: string) => ({ authorization: `Bearer ${t}` })
    const call = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(ghaToken) },
      body: JSON.stringify({ to: 'volumi', subject: 'ci', body: 'first' }),
    })
    const { thread } = (await asJson(call)) as { thread: { id: number } }
    const sent = await fetch(`${base}/api/calls/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(volToken) },
      body: JSON.stringify({ body: 'reply' }),
    })
    expect(sent.status).toBe(201)
    const inbox = (await asJson(await fetch(`${base}/api/inbox`, { headers: auth(ghaToken) }))) as {
      messages: Array<{ body: string }>
    }
    expect(inbox.messages.map((m) => m.body)).toEqual(['reply'])
  })

  test('GET /api/inbox long-polls until a message lands', async () => {
    const h = makeService()
    const ghaToken = provision(h, 'gha-docker-runner')
    const volToken = provision(h, 'volumi')
    const base = await boot(h)
    const auth = (t: string) => ({ authorization: `Bearer ${t}` })
    const parked = fetch(`${base}/api/inbox?waitMs=5000`, { headers: auth(volToken) })
    await new Promise((r) => setTimeout(r, 50))
    const call = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(ghaToken) },
      body: JSON.stringify({ to: 'volumi', subject: 'ring', body: 'pick up!' }),
    })
    expect(call.status).toBe(201)
    const inbox = (await asJson(await parked)) as { messages: Array<{ body: string }> }
    expect(inbox.messages.map((m) => m.body)).toEqual(['pick up!'])
  })

  test('cursor ack round-trip over http', async () => {
    const h = makeService()
    const ghaToken = provision(h, 'gha-docker-runner')
    const volToken = provision(h, 'volumi')
    const base = await boot(h)
    const auth = (t: string) => ({ authorization: `Bearer ${t}` })
    await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(ghaToken) },
      body: JSON.stringify({ to: 'volumi', subject: 'ci', body: 'm1' }),
    })
    const got = (await asJson(await fetch(`${base}/api/inbox`, { headers: auth(volToken) }))) as {
      cursor: number
    }
    const ack = await fetch(`${base}/api/cursor`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(volToken) },
      body: JSON.stringify({ throughMessageId: got.cursor }),
    })
    expect(ack.status).toBe(200)
    const after = (await asJson(await fetch(`${base}/api/inbox`, { headers: auth(volToken) }))) as {
      messages: unknown[]
    }
    expect(after.messages).toEqual([])
  })
})
