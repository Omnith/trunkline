export interface Clock {
  now(): number
}

export type Surface = 'http' | 'mcp' | 'admin'

// a single listen/inbox delivers at most this many messages (stated contract; see design.md)
export const DELIVERY_BATCH_LIMIT = 500

export interface PhoneEvent {
  ts: number
  op: string
  surface: Surface
  agent: string | null
  outcome: 'ok' | 'error'
  errorCode?: string
  durationMs: number
  waitedMs?: number
  threadId?: number
  messageId?: number
  deliveredCount?: number
}

export interface Emitter {
  emit(event: PhoneEvent): void
}

export interface AgentRecord {
  name: string
  tokenHash: string
  status: string | null
  lastSeenAt: number
  createdAt: number
}

export interface InviteRecord {
  id: number
  codeHash: string
  pinnedName: string | null
  expiresAt: number
  usedBy: string | null
  usedAt: number | null
  createdAt: number
}

export interface ThreadRecord {
  id: number
  subject: string
  participantA: string
  participantB: string
  openedBy: string
  status: 'open' | 'ended'
  endedBy: string | null
  endNote: string | null
  openedAt: number
  endedAt: number | null
  lastActivityAt: number
}

export interface MessageRecord {
  id: number
  threadId: number
  sender: string
  recipient: string
  body: string
  kind: 'message' | 'system'
  createdAt: number
}

export interface AgentStore {
  insertAgent(a: AgentRecord): void
  getAgent(name: string): AgentRecord | null
  getAgentByTokenHash(hash: string): AgentRecord | null
  listAgents(): AgentRecord[]
  touchAgent(name: string, ts: number): void
  setAgentStatus(name: string, status: string | null): void
  deleteAgent(name: string): void
}

export interface InviteStore {
  insertInvite(i: Omit<InviteRecord, 'id'>): number
  getInviteByCodeHash(hash: string): InviteRecord | null
  markInviteUsed(id: number, usedBy: string, usedAt: number): void
}

export interface ThreadStore {
  insertThread(t: Omit<ThreadRecord, 'id'>): number
  getThread(id: number): ThreadRecord | null
  listThreadsFor(agent: string): ThreadRecord[]
  updateThread(t: ThreadRecord): void
}

export interface MessageStore {
  insertMessage(m: Omit<MessageRecord, 'id'>): number
  listMessages(threadId: number, afterId: number, limit: number): MessageRecord[]
  listUnacked(recipient: string, afterId: number, limit: number): MessageRecord[]
  maxMessageId(): number
}

export interface CursorStore {
  getCursor(agent: string): number
  setCursor(agent: string, throughId: number): void
}

export type Store = AgentStore & InviteStore & ThreadStore & MessageStore & CursorStore
