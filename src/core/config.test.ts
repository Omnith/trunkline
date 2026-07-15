import { describe, expect, test } from 'vitest'
import { loadClientConfig, loadServerConfig } from './config.js'

describe('loadServerConfig', () => {
  test('applies effective defaults', () => {
    const cfg = loadServerConfig({})
    expect(cfg).toEqual({
      port: 4747,
      bind: '127.0.0.1',
      dbPath: './trunkline.db',
      eventsPath: './trunkline.events.jsonl',
      threadTtlHours: 24,
    })
  })

  test('reads TRUNKLINE_* overrides and rejects junk numbers', () => {
    const cfg = loadServerConfig({
      TRUNKLINE_PORT: '8080',
      TRUNKLINE_BIND: '0.0.0.0',
      TRUNKLINE_DB: 'x.db',
      TRUNKLINE_EVENTS: 'x.jsonl',
      TRUNKLINE_THREAD_TTL_HOURS: '48',
    })
    expect(cfg.port).toBe(8080)
    expect(cfg.bind).toBe('0.0.0.0')
    expect(cfg.threadTtlHours).toBe(48)
    expect(() => loadServerConfig({ TRUNKLINE_PORT: 'lots' })).toThrow(/TRUNKLINE_PORT/)
  })
})

describe('loadClientConfig', () => {
  test('fails fast, naming the missing variable', () => {
    expect(() => loadClientConfig({})).toThrow(/TRUNKLINE_URL/)
    expect(() => loadClientConfig({ TRUNKLINE_URL: 'http://x:4747' })).toThrow(/TRUNKLINE_TOKEN/)
    expect(loadClientConfig({ TRUNKLINE_URL: 'http://x:4747', TRUNKLINE_TOKEN: 'tl_t' })).toEqual({
      url: 'http://x:4747',
      token: 'tl_t',
    })
  })
})
