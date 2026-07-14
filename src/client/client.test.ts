import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { invite, makeService, type Harness } from '../testkit/harness.js'
import { buildApp } from '../http/app.js'
import { ClientError, PhoneClient, registerAgent } from './client.js'

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

describe('PhoneClient', () => {
  test('register → call → inbox → ack → hangup round-trip', async () => {
    const h = makeService()
    const url = await boot(h)
    const gha = await registerAgent(url, { name: 'gha-docker-runner', inviteCode: invite(h) })
    const vol = await registerAgent(url, { name: 'volumi', inviteCode: invite(h) })
    const ghaClient = new PhoneClient({ url, token: gha.token })
    const volClient = new PhoneClient({ url, token: vol.token })

    const book = await ghaClient.phonebook()
    expect(book.agents.map((a) => a.name).sort()).toEqual(['gha-docker-runner', 'volumi'])

    const { thread } = await ghaClient.call({ to: 'volumi', subject: 'ci', body: 'first' })
    await volClient.send({ threadId: thread.id, body: 'reply' })

    const inbox = await volClient.inbox()
    expect(inbox.messages.map((m) => m.body)).toEqual(['first'])
    await volClient.ack(inbox.cursor)
    expect((await volClient.inbox()).messages).toEqual([])

    const ended = await ghaClient.hangup(thread.id, 'done')
    expect(ended.thread.status).toBe('ended')
    const history = await ghaClient.history(thread.id)
    expect(history.messages.map((m) => m.kind)).toEqual(['message', 'message', 'system'])
  })

  test('domain errors surface as ClientError with the server code', async () => {
    const h = makeService()
    const url = await boot(h)
    const me = await registerAgent(url, { name: 'volumi', inviteCode: invite(h) })
    const client = new PhoneClient({ url, token: me.token })
    await expect(client.send({ threadId: 999, body: 'hi' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const bad = new PhoneClient({ url, token: 'ap_wrong' })
    await expect(bad.phonebook()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(bad.phonebook()).rejects.toBeInstanceOf(ClientError)
  })
})
