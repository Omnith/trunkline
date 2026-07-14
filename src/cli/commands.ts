import type {
  AckOutput,
  ListenOutput,
  MessageView,
  SendInput,
  SendOutput,
  ThreadsOutput,
  ThreadView,
} from '../core/contracts.js'
import { ClientError } from '../client/client.js'

export interface ListenClient {
  inbox(waitMs?: number): Promise<ListenOutput>
  ack(throughMessageId: number): Promise<AckOutput>
}

export interface SendToClient {
  threads(status?: 'open' | 'ended' | 'all'): Promise<ThreadsOutput>
  send(input: SendInput): Promise<SendOutput>
}

export interface AckAllClient {
  inbox(waitMs?: number): Promise<ListenOutput>
  ack(throughMessageId: number): Promise<AckOutput>
}

export interface ListenOptions {
  waitSeconds: number
  autoAck: boolean
}

const POLL_CAP_MS = 60_000

export function formatMessage(m: MessageView): string {
  const tag = m.kind === 'system' ? ' [system]' : ''
  return `#${m.id} thread=${m.threadId} from=${m.sender}${tag}\n${m.body}`
}

export function exitCodeFor(result: 'delivered' | 'timeout'): 0 | 2 {
  return result === 'delivered' ? 0 : 2
}

export async function bodyFrom(
  message: string | undefined,
  readStdin: () => Promise<string>,
): Promise<string> {
  return message ?? (await readStdin())
}

export async function listenCommand(
  client: ListenClient,
  opts: ListenOptions,
  out: (line: string) => void,
): Promise<'delivered' | 'timeout'> {
  const deadline = Date.now() + opts.waitSeconds * 1000
  for (;;) {
    const remaining = deadline - Date.now()
    const { messages } = await client.inbox(Math.max(0, Math.min(POLL_CAP_MS, remaining)))
    if (messages.length > 0) {
      for (const m of messages) out(formatMessage(m))
      const lastId = messages[messages.length - 1]?.id ?? 0
      if (opts.autoAck) {
        await client.ack(lastId)
        out(`acked through #${lastId}`)
      } else {
        out(`unacked - when processed, run: agentphone ack --through ${lastId}`)
      }
      return 'delivered'
    }
    if (Date.now() >= deadline) {
      out('no messages (listen timed out)')
      return 'timeout'
    }
  }
}

export function resolvePeerThread(threads: ThreadView[], peer: string): number {
  const open = threads.filter((t) => t.status === 'open' && t.participants.includes(peer))
  const first = open[0]
  if (open.length === 1 && first) return first.id
  if (open.length === 0) {
    throw new ClientError(
      'NO_OPEN_THREAD',
      `no open thread with "${peer}" - start one: agentphone call ${peer} --subject "..."`,
    )
  }
  throw new ClientError(
    'AMBIGUOUS_THREAD',
    `multiple open threads with "${peer}": ${open
      .map((t) => `#${t.id} "${t.subject}"`)
      .join(', ')} - use --thread <id>`,
  )
}

export async function sendTo(
  client: SendToClient,
  peer: string,
  body: string,
): Promise<SendOutput> {
  const { threads } = await client.threads('open')
  const threadId = resolvePeerThread(threads, peer)
  return client.send({ threadId, body })
}

export async function ackAll(client: AckAllClient): Promise<number> {
  const { cursor } = await client.inbox(0)
  const res = await client.ack(cursor)
  return res.ackedThroughMessageId
}
