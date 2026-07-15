import type { ZodType } from 'zod'
import type {
  AckOutput,
  CallInput,
  CallOutput,
  CheckinOutput,
  HangupOutput,
  HistoryOutput,
  ListenOutput,
  PhonebookOutput,
  RegisterInput,
  RegisterOutput,
  SendInput,
  SendOutput,
  ThreadsOutput,
} from '../core/contracts.js'
import {
  AckOutputSchema,
  CallOutputSchema,
  CheckinOutputSchema,
  HangupOutputSchema,
  HistoryOutputSchema,
  ListenOutputSchema,
  PhonebookOutputSchema,
  RegisterOutputSchema,
  SendOutputSchema,
  ThreadsOutputSchema,
} from '../core/contracts.js'

export class ClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ClientError'
  }
}

async function request<T>(
  base: string,
  path: string,
  schema: ZodType<T>,
  init: { method: string; token?: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`
  const res = await fetch(new URL(path, base), {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const json: unknown = await res.json().catch(() => undefined)
  if (!res.ok) {
    const shaped = json as { error?: { code?: string; message?: string } } | undefined
    throw new ClientError(
      shaped?.error?.code ?? `HTTP_${res.status}`,
      shaped?.error?.message ?? `request failed with status ${res.status}`,
    )
  }
  return schema.parse(json)
}

export function registerAgent(url: string, input: RegisterInput): Promise<RegisterOutput> {
  return request(url, '/api/register', RegisterOutputSchema, { method: 'POST', body: input })
}

export class PhoneClient {
  constructor(private readonly cfg: { url: string; token: string }) {}

  private req<T>(method: string, path: string, schema: ZodType<T>, body?: unknown): Promise<T> {
    return request(this.cfg.url, path, schema, { method, token: this.cfg.token, body })
  }

  checkin(status?: string): Promise<CheckinOutput> {
    return this.req('PATCH', '/api/agents/me', CheckinOutputSchema, { status })
  }
  phonebook(): Promise<PhonebookOutput> {
    return this.req('GET', '/api/agents', PhonebookOutputSchema)
  }
  call(input: CallInput): Promise<CallOutput> {
    return this.req('POST', '/api/calls', CallOutputSchema, input)
  }
  send(input: SendInput): Promise<SendOutput> {
    return this.req('POST', `/api/calls/${input.threadId}/messages`, SendOutputSchema, {
      body: input.body,
      ackThrough: input.ackThrough,
    })
  }
  inbox(waitMs = 0): Promise<ListenOutput> {
    return this.req('GET', `/api/inbox?waitMs=${waitMs}`, ListenOutputSchema)
  }
  ack(throughMessageId: number): Promise<AckOutput> {
    return this.req('PUT', '/api/cursor', AckOutputSchema, { throughMessageId })
  }
  history(threadId: number, afterId = 0, limit = 100): Promise<HistoryOutput> {
    return this.req(
      'GET',
      `/api/calls/${threadId}/messages?afterId=${afterId}&limit=${limit}`,
      HistoryOutputSchema,
    )
  }
  threads(status: 'open' | 'ended' | 'all' = 'open'): Promise<ThreadsOutput> {
    return this.req('GET', `/api/calls?status=${status}`, ThreadsOutputSchema)
  }
  hangup(threadId: number, note?: string): Promise<HangupOutput> {
    return this.req('POST', `/api/calls/${threadId}/hangup`, HangupOutputSchema, { note })
  }
}
