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

const text = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
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
  const server = new McpServer({ name: 'agentphone', version: '0.1.0' })
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
      description: 'Send a message into an existing thread (reopens an ended thread).',
      inputSchema: SendInputSchema.shape,
    },
    wrap((a: SendInput) => service.send(ctx, a)),
  )
  server.registerTool(
    'listen',
    {
      description:
        'Long-poll for unacked messages; returns immediately if any exist. Max waitMs 60000. For a background "ring" while you work, use the agentphone CLI: run `agentphone listen --wait 3600` as a background task.',
      // MCP-specific default: 25s poll window (vs. the core 0-wait "peek" default)
      inputSchema: { waitMs: z.number().int().min(0).max(60_000).default(25_000) },
    },
    wrap((a: { waitMs: number }) => service.listen(ctx, a)),
  )
  server.registerTool(
    'inbox',
    {
      description: 'Peek unacked messages (voicemail) without waiting. Messages stay unacked.',
      inputSchema: {},
    },
    wrap(() => service.listen(ctx, { waitMs: 0 })),
  )
  server.registerTool(
    'ack',
    {
      description: 'Acknowledge delivery through a message id (advances your cursor).',
      inputSchema: AckInputSchema.shape,
    },
    wrap((a: AckInput) => service.ack(ctx, a)),
  )
  server.registerTool(
    'history',
    {
      description: 'Read messages in a thread you participate in.',
      inputSchema: HistoryInputSchema.shape,
    },
    wrap((a: HistoryInput) => service.history(ctx, a)),
  )
  server.registerTool(
    'threads',
    {
      description: 'List your calls (threads), filtered by open/ended/all.',
      inputSchema: ThreadsInputSchema.shape,
    },
    wrap((a: ThreadsInput) => service.threads(ctx, a)),
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
