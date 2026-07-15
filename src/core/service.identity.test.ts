import { describe, expect, test } from 'vitest'
import { invite, makeService, provision } from '../testkit/harness.js'
import { PhoneError } from './errors.js'

describe('register (invite lifecycle)', () => {
  test('valid invite mints an tl_ token and the agent appears in the phonebook', async () => {
    const h = makeService()
    const code = invite(h)
    const out = await h.service.register({ name: 'volumi', inviteCode: code }, 'http')
    expect(out.token).toMatch(/^tl_/)
    provision(h, 'viewer')
    const book = await h.service.phonebook({ agent: 'viewer', surface: 'http' })
    expect(book.agents.map((a) => a.name)).toContain('volumi')
  })

  test('an expired invite is rejected', async () => {
    const h = makeService()
    const code = invite(h, { ttlHours: 1 })
    h.clock.advance(3600_001)
    await expect(
      h.service.register({ name: 'volumi', inviteCode: code }, 'http'),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' })
  })

  test('a taken name is rejected with NAME_TAKEN', async () => {
    const h = makeService()
    provision(h, 'volumi')
    const code = invite(h)
    await expect(
      h.service.register({ name: 'volumi', inviteCode: code }, 'http'),
    ).rejects.toMatchObject({ code: 'NAME_TAKEN' })
  })
})

describe('authenticate', () => {
  test('valid token resolves the agent and bumps lastSeenAt', () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    h.clock.advance(5000)
    const agent = h.service.authenticate(token, 'http')
    expect(agent.name).toBe('volumi')
    expect(h.store.getAgent('volumi')?.lastSeenAt).toBe(h.clock.now())
  })

  test('missing or bad token throws UNAUTHORIZED and emits one auth error event with the right surface', () => {
    const h = makeService()
    expect(() => h.service.authenticate(undefined, 'http')).toThrow(PhoneError)
    expect(() => h.service.authenticate('tl_wrong', 'mcp')).toThrow(PhoneError)
    const authEvents = h.emitter.events.filter((e) => e.op === 'auth')
    expect(authEvents).toHaveLength(2)
    expect(authEvents.map((e) => e.surface)).toEqual(['http', 'mcp'])
    expect(authEvents.every((e) => e.outcome === 'error')).toBe(true)
  })
})

describe('checkin + phonebook', () => {
  test('checkin sets the status text shown in the phonebook; omitting status preserves it', async () => {
    const h = makeService()
    provision(h, 'volumi')
    provision(h, 'gha-docker-runner')
    await h.service.checkin(
      { agent: 'volumi', surface: 'http' },
      { status: 'iterating on CI retries' },
    )
    await h.service.checkin({ agent: 'volumi', surface: 'http' }, {})
    const book = await h.service.phonebook({ agent: 'gha-docker-runner', surface: 'http' })
    expect(book.agents.find((a) => a.name === 'volumi')?.status).toBe('iterating on CI retries')
  })
})
