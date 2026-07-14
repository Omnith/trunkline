import { describe, expect, test } from 'vitest'
import { loadClientConfig, loadServerConfig } from './config.js'

describe('loadServerConfig', () => {
  test('applies effective defaults', () => {
    const cfg = loadServerConfig({})
    expect(cfg).toEqual({
      port: 4747,
      bind: '127.0.0.1',
      dbPath: './agentphone.db',
      eventsPath: './agentphone.events.jsonl',
      threadTtlHours: 24,
    })
  })

  test('reads AGENTPHONE_* overrides and rejects junk numbers', () => {
    const cfg = loadServerConfig({
      AGENTPHONE_PORT: '8080',
      AGENTPHONE_BIND: '0.0.0.0',
      AGENTPHONE_DB: 'x.db',
      AGENTPHONE_EVENTS: 'x.jsonl',
      AGENTPHONE_THREAD_TTL_HOURS: '48',
    })
    expect(cfg.port).toBe(8080)
    expect(cfg.bind).toBe('0.0.0.0')
    expect(cfg.threadTtlHours).toBe(48)
    expect(() => loadServerConfig({ AGENTPHONE_PORT: 'lots' })).toThrow(/AGENTPHONE_PORT/)
  })
})

describe('loadClientConfig', () => {
  test('fails fast, naming the missing variable', () => {
    expect(() => loadClientConfig({})).toThrow(/AGENTPHONE_URL/)
    expect(() => loadClientConfig({ AGENTPHONE_URL: 'http://x:4747' })).toThrow(/AGENTPHONE_TOKEN/)
    expect(loadClientConfig({ AGENTPHONE_URL: 'http://x:4747', AGENTPHONE_TOKEN: 'ap_t' })).toEqual(
      { url: 'http://x:4747', token: 'ap_t' },
    )
  })
})
