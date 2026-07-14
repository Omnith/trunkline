import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PhoneClient, registerAgent } from '../src/client/client.js'
import { systemClock } from '../src/core/clock.js'
import type { ServerConfig } from '../src/core/config.js'
import { createInvite } from '../src/core/provisioning.js'
import { startServer } from '../src/http/server.js'
import { SqliteStore } from '../src/store/sqlite.js'

describe('the whole story', () => {
  test('register, call, listen-wake, voicemail, ack, hangup, restart persistence, 401', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentphone-story-'))
    const cfg: ServerConfig = {
      port: 0,
      bind: '127.0.0.1',
      dbPath: join(dir, 'story.db'),
      eventsPath: join(dir, 'events.jsonl'),
      threadTtlHours: 24,
    }

    // operator mints invites on the server host (direct db access)
    const provisioning = new SqliteStore(cfg.dbPath)
    const ghaInvite = createInvite(provisioning, systemClock, { pinnedName: 'gha-docker-runner' })
    const volInvite = createInvite(provisioning, systemClock, {})
    provisioning.close()

    let running = await startServer(cfg)
    const url = `http://127.0.0.1:${running.port}`

    // both agents self-register with their invites
    const gha = await registerAgent(url, {
      name: 'gha-docker-runner',
      inviteCode: ghaInvite.code,
    })
    const vol = await registerAgent(url, { name: 'volumi', inviteCode: volInvite.code })
    const ghaClient = new PhoneClient({ url, token: gha.token })
    const volClient = new PhoneClient({ url, token: vol.token })

    // a wrong token is rejected on an authenticated route
    const badToken = await fetch(`${url}/api/agents`, {
      headers: { authorization: 'Bearer ap_wrong' },
    })
    expect(badToken.status).toBe(401)

    // volumi parks a listen (the background ring); gha calls - the listen wakes
    const parked = volClient.inbox(10_000)
    await new Promise((r) => setTimeout(r, 50))
    const { thread } = await ghaClient.call({
      to: 'volumi',
      subject: 'runner core v2',
      body: 'new build is up, try it',
    })
    const woken = await parked
    expect(woken.messages.map((m) => m.body)).toEqual(['new build is up, try it'])
    await volClient.ack(woken.cursor)

    // volumi replies while gha is NOT listening -> lands as voicemail
    await volClient.send({ threadId: thread.id, body: 'works on macos, one nit' })

    // restart the server: unacked voicemail must survive
    await running.close()
    running = await startServer(cfg)
    const url2 = `http://127.0.0.1:${running.port}`
    const ghaClient2 = new PhoneClient({ url: url2, token: gha.token })
    const volClient2 = new PhoneClient({ url: url2, token: vol.token })

    const voicemail = await ghaClient2.inbox()
    expect(voicemail.messages.map((m) => m.body)).toEqual(['works on macos, one nit'])
    await ghaClient2.ack(voicemail.cursor)

    // wrap up
    const ended = await ghaClient2.hangup(thread.id, 'shipping it, thanks')
    expect(ended.thread.status).toBe('ended')
    const volInbox = await volClient2.inbox()
    expect(volInbox.messages.map((m) => m.kind)).toEqual(['system'])

    // canonical events were written as jsonl
    const lines = readFileSync(cfg.eventsPath, 'utf8').trim().split('\n')
    expect(lines.length).toBeGreaterThan(5)
    const parsed = lines.map((l) => JSON.parse(l) as { op: string; outcome: string })
    expect(parsed.every((e) => typeof e.op === 'string' && typeof e.outcome === 'string')).toBe(
      true,
    )

    await running.close()
  })
})
