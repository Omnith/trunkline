import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import { ZodError } from 'zod'
import {
  AckInputSchema,
  CallInputSchema,
  CheckinInputSchema,
  HangupInputSchema,
  HistoryQuerySchema,
  IdParamSchema,
  ListenQuerySchema,
  RegisterInputSchema,
  SendInputSchema,
  ThreadsQuerySchema,
} from '../core/contracts.js'
import { httpStatus, PhoneError } from '../core/errors.js'
import type { Clock, Emitter, Surface } from '../core/ports.js'
import type { PhoneService } from '../core/service.js'

export type McpHandler = (
  service: PhoneService,
  agent: string,
  req: Request,
  res: Response,
) => Promise<void>

export interface AppDeps {
  service: PhoneService
  emitter: Emitter
  clock: Clock
  mcpHandler?: McpHandler
}

// express 4 does not catch async rejections; wrap every async handler
const asyncH =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next)
  }

const agentOf = (res: Response): string => res.locals.agent as string

// body-parser's oversized-payload error shape
const isPayloadTooLarge = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large'

export function buildApp(deps: AppDeps): express.Express {
  const { service, emitter, clock } = deps
  const app = express()
  app.use(express.json({ limit: '256kb' }))

  // every route stamps its op label before parsing so boundary failures can emit a canonical event
  const label =
    (op: string): RequestHandler =>
    (_req, res, next) => {
      res.locals.op = op
      next()
    }

  const auth =
    (surface: Surface): RequestHandler =>
    (req, res, next) => {
      const header = req.header('authorization')
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
      res.locals.agent = service.authenticate(token, surface).name
      res.locals.surface = surface
      next()
    }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post(
    '/api/register',
    label('register'),
    asyncH(async (req, res) => {
      const input = RegisterInputSchema.parse(req.body)
      res.status(201).json(await service.register(input, 'http'))
    }),
  )

  if (deps.mcpHandler) {
    const mcpHandler = deps.mcpHandler
    app.post(
      '/mcp',
      label('mcp'),
      auth('mcp'),
      asyncH(async (req, res) => {
        await mcpHandler(service, agentOf(res), req, res)
      }),
    )
    // stateless mode: no SSE stream, no sessions
    const noSession: RequestHandler = (_req, res) => {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless server)' },
        id: null,
      })
    }
    app.get('/mcp', noSession)
    app.delete('/mcp', noSession)
  }

  const api = express.Router()
  api.use(auth('http'))

  api.get(
    '/agents',
    label('phonebook'),
    asyncH(async (_req, res) => {
      res.json(await service.phonebook({ agent: agentOf(res), surface: 'http' }))
    }),
  )
  api.patch(
    '/agents/me',
    label('checkin'),
    asyncH(async (req, res) => {
      const input = CheckinInputSchema.parse(req.body)
      res.json(await service.checkin({ agent: agentOf(res), surface: 'http' }, input))
    }),
  )
  api.post(
    '/calls',
    label('call'),
    asyncH(async (req, res) => {
      const input = CallInputSchema.parse(req.body)
      res.status(201).json(await service.call({ agent: agentOf(res), surface: 'http' }, input))
    }),
  )
  api.get(
    '/calls',
    label('threads'),
    asyncH(async (req, res) => {
      const input = ThreadsQuerySchema.parse(req.query)
      res.json(await service.threads({ agent: agentOf(res), surface: 'http' }, input))
    }),
  )
  api.post(
    '/calls/:id/messages',
    label('send'),
    asyncH(async (req, res) => {
      const threadId = IdParamSchema.parse(req.params.id)
      const body = SendInputSchema.omit({ threadId: true }).parse(req.body)
      res
        .status(201)
        .json(await service.send({ agent: agentOf(res), surface: 'http' }, { threadId, ...body }))
    }),
  )
  api.get(
    '/calls/:id/messages',
    label('history'),
    asyncH(async (req, res) => {
      const threadId = IdParamSchema.parse(req.params.id)
      const q = HistoryQuerySchema.parse(req.query)
      res.json(await service.history({ agent: agentOf(res), surface: 'http' }, { threadId, ...q }))
    }),
  )
  api.post(
    '/calls/:id/hangup',
    label('hangup'),
    asyncH(async (req, res) => {
      const threadId = IdParamSchema.parse(req.params.id)
      const body = HangupInputSchema.omit({ threadId: true }).parse(req.body)
      res.json(
        await service.hangup({ agent: agentOf(res), surface: 'http' }, { threadId, ...body }),
      )
    }),
  )
  api.get(
    '/inbox',
    label('listen'),
    asyncH(async (req, res) => {
      const q = ListenQuerySchema.parse(req.query)
      res.json(await service.listen({ agent: agentOf(res), surface: 'http' }, q))
    }),
  )
  api.put(
    '/cursor',
    label('ack'),
    asyncH(async (req, res) => {
      const input = AckInputSchema.parse(req.body)
      res.json(await service.ack({ agent: agentOf(res), surface: 'http' }, input))
    }),
  )

  app.use('/api', api)

  // single error shape for every failure mode; boundary failures emit the canonical event here
  // (PhoneErrors were already emitted inside the service's op() wrapper - no double emit)
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const boundaryEvent = (errorCode: 'VALIDATION_ERROR' | 'PAYLOAD_TOO_LARGE'): void => {
      emitter.emit({
        ts: clock.now(),
        op: (res.locals.op as string | undefined) ?? req.path,
        surface: (res.locals.surface as Surface | undefined) ?? 'http',
        agent: (res.locals.agent as string | undefined) ?? null,
        outcome: 'error',
        errorCode,
        durationMs: 0,
      })
    }
    if (err instanceof ZodError) {
      boundaryEvent('VALIDATION_ERROR')
      res.status(422).json({
        error: { code: 'VALIDATION_ERROR', message: 'invalid input', details: err.flatten() },
      })
      return
    }
    if (isPayloadTooLarge(err)) {
      boundaryEvent('PAYLOAD_TOO_LARGE')
      res
        .status(413)
        .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'request body too large' } })
      return
    }
    if (err instanceof PhoneError) {
      res
        .status(httpStatus[err.code])
        .json({ error: { code: err.code, message: err.message, details: err.details } })
      return
    }
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } })
  })

  return app
}
