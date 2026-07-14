import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { z } from 'zod'
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
      inputSchema: { status: z.string().max(200).optional() },
    },
    wrap((a: { status?: string }) => service.checkin(ctx, a)),
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
      inputSchema: {
        to: z.string(),
        subject: z.string().min(1).max(200),
        body: z
          .string()
          .min(1)
          .max(64 * 1024)
          .optional(),
      },
    },
    wrap((a: { to: string; subject: string; body?: string }) => service.call(ctx, a)),
  )
  server.registerTool(
    'send',
    {
      description: 'Send a message into an existing thread (reopens an ended thread).',
      inputSchema: {
        threadId: z.number().int(),
        body: z
          .string()
          .min(1)
          .max(64 * 1024),
      },
    },
    wrap((a: { threadId: number; body: string }) => service.send(ctx, a)),
  )
  server.registerTool(
    'listen',
    {
      description:
        'Long-poll for unacked messages; returns immediately if any exist. Max waitMs 60000. For a background "ring" while you work, use the agentphone CLI: run `agentphone listen --wait 3600` as a background task.',
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
      inputSchema: { throughMessageId: z.number().int().min(0) },
    },
    wrap((a: { throughMessageId: number }) => service.ack(ctx, a)),
  )
  server.registerTool(
    'history',
    {
      description: 'Read messages in a thread you participate in.',
      inputSchema: {
        threadId: z.number().int(),
        afterId: z.number().int().default(0),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    wrap((a: { threadId: number; afterId: number; limit: number }) => service.history(ctx, a)),
  )
  server.registerTool(
    'threads',
    {
      description: 'List your calls (threads), filtered by open/ended/all.',
      inputSchema: { status: z.enum(['open', 'ended', 'all']).default('open') },
    },
    wrap((a: { status: 'open' | 'ended' | 'all' }) => service.threads(ctx, a)),
  )
  server.registerTool(
    'hangup',
    {
      description: 'End a call, optionally leaving a closing note (delivered as a system message).',
      inputSchema: { threadId: z.number().int(), note: z.string().max(2000).optional() },
    },
    wrap((a: { threadId: number; note?: string }) => service.hangup(ctx, a)),
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
