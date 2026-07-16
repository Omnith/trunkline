import type {
  AckOutput,
  ListenOutput,
  MessageView,
  SendInput,
  SendOutput,
} from '../core/contracts.js'

export interface ListenClient {
  inbox(waitMs?: number): Promise<ListenOutput>
  ack(throughMessageId: number): Promise<AckOutput>
}

export interface SendToClient {
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
        out(`unacked - when processed, run: trunkline ack --through ${lastId}`)
      }
      return 'delivered'
    }
    if (Date.now() >= deadline) {
      out('no messages (listen timed out)')
      return 'timeout'
    }
  }
}

export async function sendTo(
  client: SendToClient,
  peer: string,
  body: string,
  ackThrough?: number,
): Promise<SendOutput> {
  // core resolves the peer thread server-side in one round (open, then latest ended, or NOT_FOUND)
  return client.send({ to: peer, body, ackThrough })
}

export async function ackAll(client: AckAllClient): Promise<number> {
  const { cursor } = await client.inbox(0)
  const res = await client.ack(cursor)
  return res.ackedThroughMessageId
}
