import { createHash, randomBytes } from 'node:crypto'

export const newToken = (): string => 'tl_' + randomBytes(24).toString('base64url')

export const newInviteCode = (): string => 'tl-invite-' + randomBytes(12).toString('base64url')

export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex')
