import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ServerConfig } from '../core/config.js'
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
})
