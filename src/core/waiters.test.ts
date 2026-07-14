import { describe, expect, test } from 'vitest'
import { Waiters } from './waiters.js'

describe('Waiters', () => {
  test('notify wakes a parked wait before its timeout', async () => {
    const w = new Waiters()
    const started = Date.now()
    const parked = w.wait('volumi', 5000)
    w.notify('volumi')
    await parked
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('wait resolves on timeout when nobody notifies', async () => {
    const w = new Waiters()
    const started = Date.now()
    await w.wait('volumi', 50)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })

  test('isListening reflects parked waiters', async () => {
    const w = new Waiters()
    expect(w.isListening('volumi')).toBe(false)
    const parked = w.wait('volumi', 2000)
    expect(w.isListening('volumi')).toBe(true)
    w.notify('volumi')
    await parked
    expect(w.isListening('volumi')).toBe(false)
  })

  test('notify only wakes the named agent', async () => {
    const w = new Waiters()
    const other = w.wait('gha-docker-runner', 120)
    w.notify('volumi')
    expect(w.isListening('gha-docker-runner')).toBe(true)
    await other
  })
})
