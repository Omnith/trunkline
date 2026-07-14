import type {
  AgentView,
  CheckinInput,
  CheckinOutput,
  PhonebookOutput,
  RegisterInput,
  RegisterOutput,
} from './contracts.js'
import { PhoneError } from './errors.js'
import type { AgentRecord, Clock, Emitter, Store, Surface } from './ports.js'
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
}
