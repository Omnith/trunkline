import { z } from 'zod'

export const AgentNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,30}$/, 'lowercase slug, 2-31 chars, a-z 0-9 hyphen')
export const MessageBodySchema = z
  .string()
  .min(1)
  .max(64 * 1024)
export const WaitMsSchema = z.number().int().min(0).max(60_000)
export const IdParamSchema = z.coerce.number().int().positive()

export const RegisterInputSchema = z.object({
  name: AgentNameSchema,
  inviteCode: z.string().min(8),
})
export const RegisterOutputSchema = z.object({ name: AgentNameSchema, token: z.string() })

export const CheckinInputSchema = z.object({ status: z.string().max(200).optional() })
export const CheckinOutputSchema = z.object({
  name: AgentNameSchema,
  status: z.string().nullable(),
})

export const AgentViewSchema = z.object({
  name: AgentNameSchema,
  status: z.string().nullable(),
  lastSeenAt: z.number().int(),
  listening: z.boolean(),
})
export const PhonebookOutputSchema = z.object({ agents: z.array(AgentViewSchema) })

export const MessageViewSchema = z.object({
  id: z.number().int(),
  threadId: z.number().int(),
  sender: AgentNameSchema,
  recipient: AgentNameSchema,
  body: z.string(),
  kind: z.enum(['message', 'system']),
  createdAt: z.number().int(),
})

export const ThreadViewSchema = z.object({
  id: z.number().int(),
  subject: z.string(),
  participants: z.tuple([AgentNameSchema, AgentNameSchema]),
  openedBy: AgentNameSchema,
  status: z.enum(['open', 'ended']),
  endedBy: AgentNameSchema.nullable(),
  endNote: z.string().nullable(),
  openedAt: z.number().int(),
  lastActivityAt: z.number().int(),
})

export const CallInputSchema = z.object({
  to: AgentNameSchema,
  subject: z.string().min(1).max(200),
  body: MessageBodySchema.optional(),
})
export const CallOutputSchema = z.object({
  thread: ThreadViewSchema,
  message: MessageViewSchema.nullable(),
})

export const SendInputSchema = z.object({
  threadId: z.number().int().positive(),
  body: MessageBodySchema,
})
export const SendOutputSchema = z.object({ message: MessageViewSchema })

// NOTE: no threadId on listen/inbox — a filtered listen cannot safely drive the single
// global cursor (see design.md, Delivery semantics). history is the per-thread read.
export const ListenInputSchema = z.object({
  waitMs: WaitMsSchema.default(0),
})
export const ListenOutputSchema = z.object({
  messages: z.array(MessageViewSchema),
  cursor: z.number().int(),
})

export const AckInputSchema = z.object({ throughMessageId: z.number().int().min(0) })
export const AckOutputSchema = z.object({ ackedThroughMessageId: z.number().int() })

export const HistoryInputSchema = z.object({
  threadId: z.number().int().positive(),
  afterId: z.number().int().default(0),
  limit: z.number().int().min(1).max(500).default(100),
})
export const HistoryOutputSchema = z.object({ messages: z.array(MessageViewSchema) })

export const ThreadsInputSchema = z.object({
  status: z.enum(['open', 'ended', 'all']).default('open'),
})
export const ThreadsOutputSchema = z.object({ threads: z.array(ThreadViewSchema) })

export const HangupInputSchema = z.object({
  threadId: z.number().int().positive(),
  note: z.string().max(2000).optional(),
})
export const HangupOutputSchema = z.object({ thread: ThreadViewSchema })

// http query-string variants (coerced numbers)
export const ListenQuerySchema = z.object({
  waitMs: z.coerce.number().int().min(0).max(60_000).default(0),
})
export const HistoryQuerySchema = z.object({
  afterId: z.coerce.number().int().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export const ThreadsQuerySchema = z.object({
  status: z.enum(['open', 'ended', 'all']).default('open'),
})

export type RegisterInput = z.infer<typeof RegisterInputSchema>
export type RegisterOutput = z.infer<typeof RegisterOutputSchema>
export type CheckinInput = z.infer<typeof CheckinInputSchema>
export type CheckinOutput = z.infer<typeof CheckinOutputSchema>
export type AgentView = z.infer<typeof AgentViewSchema>
export type PhonebookOutput = z.infer<typeof PhonebookOutputSchema>
export type MessageView = z.infer<typeof MessageViewSchema>
export type ThreadView = z.infer<typeof ThreadViewSchema>
export type CallInput = z.infer<typeof CallInputSchema>
export type CallOutput = z.infer<typeof CallOutputSchema>
export type SendInput = z.infer<typeof SendInputSchema>
export type SendOutput = z.infer<typeof SendOutputSchema>
export type ListenInput = z.infer<typeof ListenInputSchema>
export type ListenOutput = z.infer<typeof ListenOutputSchema>
export type AckInput = z.infer<typeof AckInputSchema>
export type AckOutput = z.infer<typeof AckOutputSchema>
export type HistoryInput = z.infer<typeof HistoryInputSchema>
export type HistoryOutput = z.infer<typeof HistoryOutputSchema>
export type ThreadsInput = z.infer<typeof ThreadsInputSchema>
export type ThreadsOutput = z.infer<typeof ThreadsOutputSchema>
export type HangupInput = z.infer<typeof HangupInputSchema>
export type HangupOutput = z.infer<typeof HangupOutputSchema>
