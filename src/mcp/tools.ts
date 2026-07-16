import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { z } from 'zod'
import {
  AckInputSchema,
  CallInputSchema,
  CheckinInputSchema,
  HangupInputSchema,
  HistoryInputSchema,
  SendInputSchema,
  ThreadsInputSchema,
  type AckInput,
  type CallInput,
  type CheckinInput,
  type HangupInput,
  type HistoryInput,
  type SendInput,
  type ThreadsInput,
} from '../core/contracts.js'
import { PhoneError } from '../core/errors.js'
import type { CallCtx, PhoneService } from '../core/service.js'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

// operating manual surfaced to visiting MCP agents via the initialize response
const INSTRUCTIONS = `trunkline connects agents on different machines. Economics: every tool
call costs you a full think-act cycle; the server is milliseconds. Rules:
1. listen WAITS up to waitMs for NEW unacked messages - to read what exists, use inbox
   (peek) or history. For a background ring between turns, use the trunkline CLI.
2. Reply and ack in ONE call: send {to: "<peer>", body, ackThrough: <cursor>} - to is the
   peer name; no threads lookup needed.
3. snapshot = phonebook + open threads + unacked inbox in one call - the "what's my state" opener.
4. Messages redeliver until acked; ack with listen/inbox {ack:true} or send.ackThrough.`

// compact: smaller results stream into the visiting agent's context faster and cheaper
const text = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
})

const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return text(await fn(args))
    } catch (e) {
      if (e instanceof PhoneError) {
        return { ...text({ error: { code: e.code, message: e.message } }), isError: true }
      }
      throw e
    }
  }

export function buildMcpServer(service: PhoneService, agent: string): McpServer {
  const server = new McpServer(
    { name: 'trunkline', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  )
  const ctx: CallCtx = { agent, surface: 'mcp' }

  server.registerTool(
    'checkin',
    {
      description: 'Update your phonebook status text.',
      inputSchema: CheckinInputSchema.shape,
    },
    wrap((a: CheckinInput) => service.checkin(ctx, a)),
  )
  server.registerTool(
    'phonebook',
    {
      description: 'List registered agents with presence (lastSeenAt, listening).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(() => service.phonebook(ctx)),
  )
  server.registerTool(
    'call',
    {
      description: 'Open a call (thread) with another agent, optionally sending a first message.',
      inputSchema: CallInputSchema.shape,
    },
    wrap((a: CallInput) => service.call(ctx, a)),
  )
  server.registerTool(
    'send',
    {
      description:
        'Reply to a peer by name in one round: send {to, body} resolves the open thread with that peer (no threads lookup). Or target a thread directly with {threadId, body} (reopens an ended thread) — pass exactly one of to/threadId. Add ackThrough to also ack your inbox through that id — reply+ack in one call.',
      inputSchema: SendInputSchema.shape,
    },
    wrap((a: SendInput) => service.send(ctx, a)),
  )
  server.registerTool(
    'listen',
    {
      description:
        'WAITS up to waitMs (default 25s) for unacked messages; returns immediately only if some are already waiting. Pass ack:true to acknowledge the delivered batch in the same call (read+ack in one round). To read without waiting use inbox or history. For the background ring, use the CLI: `trunkline listen --wait 3600` as a background task.',
      // MCP-specific default: 25s poll window (vs. the core 0-wait "peek" default)
      inputSchema: {
        waitMs: z.number().int().min(0).max(60_000).default(25_000),
        ack: z.boolean().default(false),
      },
    },
    wrap(async (a: { waitMs: number; ack: boolean }) => {
      const result = await service.listen(ctx, { waitMs: a.waitMs })
      let acked = false
      // two ops -> two canonical events, same as CLI `listen --ack`
      if (a.ack && result.messages.length > 0) {
        await service.ack(ctx, { throughMessageId: result.cursor })
        acked = true
      }
      if (result.messages.length === 0) return result
      const hint = acked
        ? 'reply with send {to, body}'
        : `reply+ack in one call: send {to, body, ackThrough: ${result.cursor}}`
      return { ...result, hint }
    }),
  )
  server.registerTool(
    'inbox',
    {
      description: 'Peek unacked messages (voicemail) without waiting. Messages stay unacked.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      const result = await service.listen(ctx, { waitMs: 0 })
      if (result.messages.length === 0) return result
      return {
        ...result,
        hint: `reply+ack in one call: send {to, body, ackThrough: ${result.cursor}}`,
      }
    }),
  )
  server.registerTool(
    'ack',
    {
      description: 'Acknowledge delivery through a message id (advances your cursor).',
      inputSchema: AckInputSchema.shape,
      annotations: { idempotentHint: true },
    },
    wrap((a: AckInput) => service.ack(ctx, a)),
  )
  server.registerTool(
    'history',
    {
      description: 'Read messages in a thread you participate in.',
      inputSchema: HistoryInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    wrap((a: HistoryInput) => service.history(ctx, a)),
  )
  server.registerTool(
    'threads',
    {
      description: 'List your calls (threads), filtered by open/ended/all.',
      inputSchema: ThreadsInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    wrap((a: ThreadsInput) => service.threads(ctx, a)),
  )
  server.registerTool(
    'snapshot',
    {
      description:
        'Your state in one call: phonebook (agents) + open threads + unacked inbox (messages, cursor). The "what\'s my state" opener; a peek — does not advance your cursor.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      // three existing reads composed; each emits its own canonical event (no snapshot-level event)
      const book = await service.phonebook(ctx)
      const open = await service.threads(ctx, { status: 'open' })
      const inbox = await service.listen(ctx, { waitMs: 0 })
      return {
        agents: book.agents,
        threads: open.threads,
        messages: inbox.messages,
        cursor: inbox.cursor,
      }
    }),
  )
  server.registerTool(
    'hangup',
    {
      description: 'End a call, optionally leaving a closing note (delivered as a system message).',
      inputSchema: HangupInputSchema.shape,
    },
    wrap((a: HangupInput) => service.hangup(ctx, a)),
  )

  return server
}

// stateless: fresh server+transport per request, identity bound from the auth middleware
export async function handleMcpRequest(
  service: PhoneService,
  agent: string,
  req: Request,
  res: Response,
): Promise<void> {
  const server = buildMcpServer(service, agent)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
