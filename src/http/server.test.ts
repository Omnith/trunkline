import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { systemClock } from '../core/clock.js'
import type { ServerConfig } from '../core/config.js'
import { createInvite } from '../core/provisioning.js'
import { SqliteStore } from '../store/sqlite.js'
import { startServer } from './server.js'

// fresh temp db/events per config so no repo files are created and the only
// difference between two configs is the bind port
function cfgOnPort(port: number): ServerConfig {
  const dir = mkdtempSync(join(tmpdir(), 'agentphone-server-'))
  return {
    port,
    bind: '127.0.0.1',
    dbPath: join(dir, 'agentphone.db'),
    eventsPath: join(dir, 'events.jsonl'),
    threadTtlHours: 24,
  }
}

describe('startServer', () => {
  test('rejects when the requested bind port is already in use', async () => {
    const first = await startServer(cfgOnPort(0))
    try {
      await expect(startServer(cfgOnPort(first.port))).rejects.toThrow()
    } finally {
      await first.close()
    }
  }, 5000)

  test('close() releases parked long-polls, then shuts down cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentphone-shutdown-'))
    const dbPath = join(dir, 'agentphone.db')
    const provisioning = new SqliteStore(dbPath)
    const invite = createInvite(provisioning, systemClock, { ttlHours: 1 })
    provisioning.close()

    const running = await startServer({
      port: 0,
      bind: '127.0.0.1',
      dbPath,
      eventsPath: join(dir, 'events.jsonl'),
      threadTtlHours: 24,
    })
    const base = `http://127.0.0.1:${running.port}`
    const reg = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'parked', inviteCode: invite.code }),
    })
    expect(reg.status).toBe(201)
    const { token } = (await reg.json()) as { token: string }

    const parked = fetch(`${base}/api/inbox?waitMs=30000`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await new Promise((r) => setTimeout(r, 150)) // let it park

    const t0 = Date.now()
    await running.close()
    const res = await parked
    expect(res.status).toBe(200)
    expect(((await res.json()) as { messages: unknown[] }).messages).toEqual([])
    expect(Date.now() - t0).toBeLessThan(5_000) // not the 30s window, and not undici keep-alive
    await running.close() // idempotent: second close must not throw
  })
})
