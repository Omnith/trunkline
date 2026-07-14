import type { AgentRecord, AgentStore, Clock, InviteStore } from './ports.js'
import { HOUR_MS } from './ports.js'
import { hashSecret, newInviteCode, newToken } from './tokens.js'

export function createInvite(
  store: InviteStore,
  clock: Clock,
  opts: { pinnedName?: string; ttlHours?: number },
): { code: string; expiresAt: number } {
  const code = newInviteCode()
  const expiresAt = clock.now() + (opts.ttlHours ?? 24) * HOUR_MS
  store.insertInvite({
    codeHash: hashSecret(code),
    pinnedName: opts.pinnedName ?? null,
    expiresAt,
    usedBy: null,
    usedAt: null,
    createdAt: clock.now(),
  })
  return { code, expiresAt }
}

export function addAgent(
  store: AgentStore,
  clock: Clock,
  name: string,
): { name: string; token: string } {
  if (store.getAgent(name)) throw new Error(`agent "${name}" already exists`)
  const token = newToken()
  store.insertAgent({
    name,
    tokenHash: hashSecret(token),
    status: null,
    lastSeenAt: clock.now(),
    createdAt: clock.now(),
  })
  return { name, token }
}

export function revokeAgent(store: AgentStore, name: string): void {
  if (!store.getAgent(name)) throw new Error(`agent "${name}" does not exist`)
  store.deleteAgent(name)
}

export function listAgentRecords(store: AgentStore): AgentRecord[] {
  return store.listAgents()
}
