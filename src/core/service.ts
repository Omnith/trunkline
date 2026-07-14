import type {
  AckInput,
  AckOutput,
  AgentView,
  CallInput,
  CallOutput,
  CheckinInput,
  CheckinOutput,
  ListenInput,
  ListenOutput,
  MessageView,
  PhonebookOutput,
  RegisterInput,
  RegisterOutput,
  SendInput,
  SendOutput,
  ThreadView,
} from './contracts.js'
import { PhoneError } from './errors.js'
import { DELIVERY_BATCH_LIMIT } from './ports.js'
import type {
  AgentRecord,
  Clock,
  Emitter,
  MessageRecord,
  Store,
  Surface,
  ThreadRecord,
} from './ports.js'
import { hashSecret, newToken } from './tokens.js'
import { Waiters } from './waiters.js'

export interface CallCtx {
  agent: string
  surface: Surface
}

const DEFAULT_TTL_MS = 24 * 3600_000

type EventFields = {
  waitedMs?: number
  threadId?: number
  messageId?: number
  deliveredCount?: number
}

export class PhoneService {
  private readonly waiters = new Waiters()

  constructor(
    private readonly store: Store,
    private readonly emitter: Emitter,
    private readonly clock: Clock,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  // --- instrumentation: exactly one canonical wide event per operation ---
  private async op<T>(
    op: string,
    surface: Surface,
    agent: string | null,
    fn: (ev: EventFields) => T | Promise<T>,
  ): Promise<T> {
    const start = this.clock.now()
    const ev: EventFields = {}
    try {
      const result = await fn(ev)
      this.emitter.emit({
        ts: start,
        op,
        surface,
        agent,
        outcome: 'ok',
        durationMs: this.clock.now() - start,
        ...ev,
      })
      return result
    } catch (e) {
      this.emitter.emit({
        ts: start,
        op,
        surface,
        agent,
        outcome: 'error',
        errorCode: e instanceof PhoneError ? e.code : 'INTERNAL',
        durationMs: this.clock.now() - start,
        ...ev,
      })
      throw e
    }
  }

  // --- auth (sync; emits only on failure so each request still yields exactly one event) ---
  authenticate(token: string | undefined, surface: Surface): AgentRecord {
    if (token !== undefined) {
      const agent = this.store.getAgentByTokenHash(hashSecret(token))
      if (agent) {
        this.store.touchAgent(agent.name, this.clock.now())
        return { ...agent, lastSeenAt: this.clock.now() }
      }
    }
    this.emitter.emit({
      ts: this.clock.now(),
      op: 'auth',
      surface,
      agent: null,
      outcome: 'error',
      errorCode: 'UNAUTHORIZED',
      durationMs: 0,
    })
    throw new PhoneError('UNAUTHORIZED', 'missing or invalid bearer token')
  }

  isListening(agent: string): boolean {
    return this.waiters.isListening(agent)
  }

  // --- identity ---
  register(input: RegisterInput, surface: Surface): Promise<RegisterOutput> {
    return this.op('register', surface, input.name, () => {
      const now = this.clock.now()
      const invite = this.store.getInviteByCodeHash(hashSecret(input.inviteCode))
      if (!invite || invite.usedBy !== null || invite.expiresAt <= now) {
        throw new PhoneError('INVITE_INVALID', 'invite code is invalid, already used, or expired')
      }
      if (invite.pinnedName !== null && invite.pinnedName !== input.name) {
        throw new PhoneError('INVITE_INVALID', `invite is pinned to name "${invite.pinnedName}"`)
      }
      if (this.store.getAgent(input.name)) {
        throw new PhoneError('NAME_TAKEN', `agent name "${input.name}" is already registered`)
      }
      const token = newToken()
      this.store.insertAgent({
        name: input.name,
        tokenHash: hashSecret(token),
        status: null,
        lastSeenAt: now,
        createdAt: now,
      })
      this.store.markInviteUsed(invite.id, input.name, now)
      return { name: input.name, token }
    })
  }

  checkin(ctx: CallCtx, input: CheckinInput): Promise<CheckinOutput> {
    return this.op('checkin', ctx.surface, ctx.agent, () => {
      if (input.status !== undefined) this.store.setAgentStatus(ctx.agent, input.status)
      const agent = this.store.getAgent(ctx.agent)
      if (!agent) throw new PhoneError('NOT_FOUND', `unknown agent "${ctx.agent}"`)
      return { name: agent.name, status: agent.status }
    })
  }

  phonebook(ctx: CallCtx): Promise<PhonebookOutput> {
    return this.op('phonebook', ctx.surface, ctx.agent, () => ({
      agents: this.store.listAgents().map((a): AgentView => ({
        name: a.name,
        status: a.status,
        lastSeenAt: a.lastSeenAt,
        listening: this.waiters.isListening(a.name),
      })),
    }))
  }

  // --- conversations ---
  call(ctx: CallCtx, input: CallInput): Promise<CallOutput> {
    return this.op('call', ctx.surface, ctx.agent, (ev) => {
      if (input.to === ctx.agent) throw new PhoneError('VALIDATION_ERROR', 'cannot call yourself')
      if (!this.store.getAgent(input.to)) {
        throw new PhoneError('NOT_FOUND', `unknown agent "${input.to}"`)
      }
      const now = this.clock.now()
      const threadId = this.store.insertThread({
        subject: input.subject,
        participantA: ctx.agent,
        participantB: input.to,
        openedBy: ctx.agent,
        status: 'open',
        endedBy: null,
        endNote: null,
        openedAt: now,
        endedAt: null,
        lastActivityAt: now,
      })
      ev.threadId = threadId
      let message: MessageView | null = null
      if (input.body !== undefined) {
        const id = this.store.insertMessage({
          threadId,
          sender: ctx.agent,
          recipient: input.to,
          body: input.body,
          kind: 'message',
          createdAt: now,
        })
        ev.messageId = id
        this.waiters.notify(input.to)
        message = {
          id,
          threadId,
          sender: ctx.agent,
          recipient: input.to,
          body: input.body,
          kind: 'message',
          createdAt: now,
        }
      }
      const thread = this.store.getThread(threadId)
      if (!thread) throw new PhoneError('INTERNAL', 'thread vanished after insert')
      return { thread: this.toThreadView(thread), message }
    })
  }

  send(ctx: CallCtx, input: SendInput): Promise<SendOutput> {
    return this.op('send', ctx.surface, ctx.agent, (ev) => {
      const thread = this.requireParticipant(input.threadId, ctx.agent)
      const now = this.clock.now()
      const recipient = this.otherParticipant(thread, ctx.agent)
      const id = this.store.insertMessage({
        threadId: thread.id,
        sender: ctx.agent,
        recipient,
        body: input.body,
        kind: 'message',
        createdAt: now,
      })
      // reopen-on-send: sending always makes the thread open again (design: status is advisory)
      this.store.updateThread({
        ...thread,
        status: 'open',
        endedBy: null,
        endNote: null,
        endedAt: null,
        lastActivityAt: now,
      })
      this.waiters.notify(recipient)
      ev.threadId = thread.id
      ev.messageId = id
      return {
        message: this.toMessageView({
          id,
          threadId: thread.id,
          sender: ctx.agent,
          recipient,
          body: input.body,
          kind: 'message',
          createdAt: now,
        }),
      }
    })
  }

  // --- delivery ---
  listen(ctx: CallCtx, input: ListenInput): Promise<ListenOutput> {
    return this.op('listen', ctx.surface, ctx.agent, async (ev) => {
      // wall-clock window: Waiters uses real timers; the injected Clock is domain time only
      const startedAt = Date.now()
      for (;;) {
        const cursor = this.store.getCursor(ctx.agent)
        const records = this.store.listUnacked(ctx.agent, cursor, DELIVERY_BATCH_LIMIT)
        const elapsed = Date.now() - startedAt
        if (records.length > 0 || elapsed >= input.waitMs) {
          ev.deliveredCount = records.length
          ev.waitedMs = elapsed
          const last = records[records.length - 1]
          return {
            messages: records.map((m) => this.toMessageView(m)),
            cursor: last ? last.id : cursor,
          }
        }
        await this.waiters.wait(ctx.agent, input.waitMs - elapsed)
      }
    })
  }

  ack(ctx: CallCtx, input: AckInput): Promise<AckOutput> {
    return this.op('ack', ctx.surface, ctx.agent, () => {
      const current = this.store.getCursor(ctx.agent)
      const cap = this.store.maxMessageId()
      const next = Math.max(current, Math.min(input.throughMessageId, cap))
      this.store.setCursor(ctx.agent, next)
      return { ackedThroughMessageId: next }
    })
  }

  // --- view/guard helpers ---
  private effectiveStatus(t: ThreadRecord): 'open' | 'ended' {
    if (t.status === 'ended') return 'ended'
    return this.clock.now() - t.lastActivityAt > this.ttlMs ? 'ended' : 'open'
  }

  private toThreadView(t: ThreadRecord): ThreadView {
    return {
      id: t.id,
      subject: t.subject,
      participants: [t.participantA, t.participantB],
      openedBy: t.openedBy,
      status: this.effectiveStatus(t),
      endedBy: t.endedBy,
      endNote: t.endNote,
      openedAt: t.openedAt,
      lastActivityAt: t.lastActivityAt,
    }
  }

  private toMessageView(m: MessageRecord): MessageView {
    return {
      id: m.id,
      threadId: m.threadId,
      sender: m.sender,
      recipient: m.recipient,
      body: m.body,
      kind: m.kind,
      createdAt: m.createdAt,
    }
  }

  private requireParticipant(threadId: number, agent: string): ThreadRecord {
    const thread = this.store.getThread(threadId)
    if (!thread || (thread.participantA !== agent && thread.participantB !== agent)) {
      throw new PhoneError('NOT_FOUND', `no thread #${threadId} for agent "${agent}"`)
    }
    return thread
  }

  private otherParticipant(t: ThreadRecord, agent: string): string {
    return t.participantA === agent ? t.participantB : t.participantA
  }
}
