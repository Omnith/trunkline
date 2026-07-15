import { describe, expect, test } from 'vitest'
import { makeService } from '../testkit/harness.js'
import { addAgent, createInvite, revokeAgent } from './provisioning.js'

describe('provisioning', () => {
  test('createInvite produces a code the service accepts once', async () => {
    const h = makeService()
    const { code } = createInvite(h.store, h.clock, {})
    const out = await h.service.register({ name: 'volumi', inviteCode: code }, 'http')
    expect(out.token).toMatch(/^tl_/)
    await expect(
      h.service.register({ name: 'other', inviteCode: code }, 'http'),
    ).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
  })

  test('createInvite honors pinned name and ttl', async () => {
    const h = makeService()
    const { code } = createInvite(h.store, h.clock, { pinnedName: 'lab7', ttlHours: 1 })
    await expect(
      h.service.register({ name: 'volumi', inviteCode: code }, 'http'),
    ).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
    h.clock.advance(3600_001)
    await expect(
      h.service.register({ name: 'lab7', inviteCode: code }, 'http'),
    ).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
  })

  test('addAgent mints a working token; revokeAgent kills it', () => {
    const h = makeService()
    const { token } = addAgent(h.store, h.clock, 'volumi')
    expect(h.service.authenticate(token, 'http').name).toBe('volumi')
    revokeAgent(h.store, 'volumi')
    expect(() => h.service.authenticate(token, 'http')).toThrow()
  })

  test('addAgent rejects a taken name', () => {
    const h = makeService()
    addAgent(h.store, h.clock, 'volumi')
    expect(() => addAgent(h.store, h.clock, 'volumi')).toThrow(/already/)
  })
})
