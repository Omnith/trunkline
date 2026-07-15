import { describe, expect, test } from 'vitest'
import { hashSecret, newInviteCode, newToken } from './tokens.js'

describe('tokens', () => {
  test('tokens are prefixed, unique, and hash deterministically', () => {
    const a = newToken()
    const b = newToken()
    expect(a).toMatch(/^tl_[A-Za-z0-9_-]{20,}$/)
    expect(a).not.toBe(b)
    expect(newInviteCode()).toMatch(/^tl-invite-[A-Za-z0-9_-]{12,}$/)
    expect(hashSecret(a)).toBe(hashSecret(a))
    expect(hashSecret(a)).not.toBe(hashSecret(b))
    expect(hashSecret(a)).toMatch(/^[0-9a-f]{64}$/)
  })
})
