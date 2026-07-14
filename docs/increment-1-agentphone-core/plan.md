# agentphone Core Implementation Plan (Increment 1) — rev 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Rev 2 incorporates the plan-review gate findings (see `impl.md` → Review findings). Headline changes vs rev 1: no `threadId` on listen/inbox, wall-clock long-poll window, lint config fixes, TDD-honest task sequencing for the core, injected MCP handler, testkit outside core, provisioning in core, boundary events, CI matrix task.

**Goal:** Build the agentphone server — phonebook, calls (threads), messages, long-poll listen, voicemail — with one contract-first core and three thin surfaces (HTTP JSON API, MCP streamable-HTTP, typed CLI), per `docs/increment-1-agentphone-core/design.md`.

**Architecture:** zod contracts + `PhoneService` core with injected ports (`Store`, `Emitter`, `Clock`); better-sqlite3 store; express HTTP adapter with bearer-token auth middleware; MCP adapter injected into the HTTP app at the composition root; typed fetch client consumed by a commander CLI. Dependencies flow inward: `cli → client → HTTP → core ← store`, `mcp → core`; `http` never imports `mcp`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, Node 20+), express 4, zod 3, @modelcontextprotocol/sdk, better-sqlite3, commander, vitest, tsup, eslint (typescript-eslint strict) + prettier.

**Conventions (from project CLAUDE.md — apply in every task):**
- TDD: write the failing test first, watch it fail, implement, watch it pass, commit.
- Tests assert OUR contracts, not zod/express/sqlite behavior. Minimum-optimal set.
- No `as any`. Fail-fast required config. No ad-hoc logging on core paths — canonical wide events only.
- Commit format: `type(component): message` (e.g. `feat(core): add delivery semantics`).
- Do not use `cd` when already in `O:\_web\omnith\agentphone`. No git pager flags.
- The injected `Clock` is for **domain time** (createdAt, lastActivityAt, TTL derivation, event `ts`) only. Long-poll scheduling uses real wall-clock (`Date.now()`), matching the real timers in `Waiters`.

---

## File structure (locked in)

```
package.json / tsconfig.json / eslint.config.js / .prettierrc.json / .prettierignore /
vitest.config.ts / tsup.config.ts / .gitignore / .github/workflows/ci.yml
src/core/errors.ts        PhoneError, codes, http status map
src/core/ports.ts         Store (5 segregated interfaces), Emitter, Clock, record types
src/core/clock.ts         systemClock
src/core/tokens.ts        newToken / newInviteCode / hashSecret
src/core/contracts.ts     zod schemas + inferred types for all verbs
src/core/waiters.ts       Waiters (long-poll park/notify)
src/core/provisioning.ts  createInvite / addAgent / revokeAgent / listAgentRecords (port consumers)
src/core/service.ts       PhoneService (11 verbs + authenticate + instrumentation)
src/core/config.ts        loadServerConfig / loadClientConfig
src/store/sqlite.ts       SqliteStore implements Store
src/obs/emitters.ts       JsonlEmitter, MemoryEmitter
src/testkit/harness.ts    FakeClock, makeService, provision/invite helpers (test-only; sits ABOVE core)
src/http/app.ts           buildApp (routes, auth middleware factory, error handler; mcpHandler injected)
src/http/server.ts        startServer(config) — the composition root (wires store, emitters, mcp)
src/mcp/tools.ts          buildMcpServer + handleMcpRequest (imported only by server.ts and mcp tests)
src/client/client.ts      PhoneClient + ClientError + registerAgent
src/cli/commands.ts       listenCommand, exitCodeFor, bodyFrom, sendTo, ackAll, resolvePeerThread, formatMessage
src/cli/index.ts          #!/usr/bin/env node — commander wiring (thin; no logic)
test/story.test.ts        end-to-end story incl. restart persistence + 401
test/mcp.test.ts          MCP SDK client round-trip (send + listen tools included)
```

Unit tests are colocated: `src/core/waiters.test.ts`, `src/core/service.identity.test.ts`, `src/core/service.delivery.test.ts`, `src/core/service.lifecycle.test.ts`, `src/core/provisioning.test.ts`, `src/store/sqlite.test.ts`, `src/core/config.test.ts`, `src/http/app.test.ts`, `src/client/client.test.ts`, `src/cli/commands.test.ts`.

---

## Phase 0 — Scaffold

### Task 1: Repo scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `tsup.config.ts`, `.gitignore`, `src/smoke.test.ts`

- [ ] **Step 1: Create feature branch**

```powershell
git checkout -b feat/ffl-1-agentphone-core
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "agentphone",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "agentphone": "dist/agentphone.js" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write ."
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.15.0",
    "better-sqlite3": "^12.2.0",
    "commander": "^14.0.0",
    "express": "^4.21.2",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/express": "^4.17.23",
    "@types/node": "^20.19.0",
    "eslint": "^9.30.0",
    "prettier": "^3.6.0",
    "tsup": "^8.5.0",
    "typescript": "^5.8.0",
    "typescript-eslint": "^8.35.0",
    "vitest": "^3.2.0"
  }
}
```

(`@types/node` tracks the lowest supported runtime — Node 20 — to avoid type-vs-runtime skew.)

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src", "test", "vitest.config.ts", "tsup.config.ts"]
}
```

(`"lib": ["ES2022"]` keeps DOM globals out; `fetch`/`Response` types come from `@types/node`.)

- [ ] **Step 4: Write `eslint.config.js`**

```js
import tseslint from 'typescript-eslint'

export default tseslint.config({ ignores: ['dist/**', 'node_modules/**'] }, ...tseslint.configs.strict, {
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
  },
})
```

(The `argsIgnorePattern` is load-bearing: express error handlers require a trailing unused `_next` parameter to be recognized as error middleware.)

- [ ] **Step 5: Write `.prettierrc.json` and `.prettierignore`**

`.prettierrc.json`:

```json
{ "semi": false, "singleQuote": true, "printWidth": 100 }
```

`.prettierignore` (prettier does NOT read .gitignore; without this, `prettier --check .` fails on `dist/` after any build and would reformat the hand-written design docs):

```
node_modules/
dist/
coverage/
package-lock.json
*.md
*.jsonl
*.db*
```

- [ ] **Step 6: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
})
```

- [ ] **Step 7: Write `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { agentphone: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
})
```

- [ ] **Step 8: Write `.gitignore`**

```
node_modules/
dist/
coverage/
*.db
*.db-journal
*.db-wal
*.db-shm
*.jsonl
```

- [ ] **Step 9: Write `src/smoke.test.ts`** (temporary — deleted in Task 2)

```ts
import { expect, test } from 'vitest'

test('toolchain smoke', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 10: Install and verify toolchain**

```powershell
npm install
npm test
npm run typecheck
npm run lint
```

Expected: install succeeds (better-sqlite3 uses a prebuilt binary on Windows/Node 20+); 1 test passes; typecheck and lint clean. If prettier flags a file you just wrote, run `npm run format` (it only touches non-ignored files) and re-check.

- [ ] **Step 11: Commit**

```powershell
git add -A
git commit -m "chore: scaffold typescript toolchain (tsup, vitest, eslint, prettier)"
```

---

## Phase 1 — Core domain

### Task 2: Errors, ports, clock, tokens

**Files:**
- Create: `src/core/errors.ts`, `src/core/ports.ts`, `src/core/clock.ts`, `src/core/tokens.ts`
- Test: `src/core/tokens.test.ts`
- Delete: `src/smoke.test.ts`

- [ ] **Step 1: Write the failing test** — `src/core/tokens.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { hashSecret, newInviteCode, newToken } from './tokens.js'

describe('tokens', () => {
  test('tokens are prefixed, unique, and hash deterministically', () => {
    const a = newToken()
    const b = newToken()
    expect(a).toMatch(/^ap_[A-Za-z0-9_-]{20,}$/)
    expect(a).not.toBe(b)
    expect(newInviteCode()).toMatch(/^ap-invite-[A-Za-z0-9_-]{12,}$/)
    expect(hashSecret(a)).toBe(hashSecret(a))
    expect(hashSecret(a)).not.toBe(hashSecret(b))
    expect(hashSecret(a)).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/tokens.test.ts`
Expected: FAIL — cannot find module `./tokens.js`

- [ ] **Step 3: Write `src/core/tokens.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto'

export const newToken = (): string => 'ap_' + randomBytes(24).toString('base64url')

export const newInviteCode = (): string => 'ap-invite-' + randomBytes(12).toString('base64url')

export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex')
```

- [ ] **Step 4: Write `src/core/errors.ts`**

```ts
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'NAME_TAKEN'
  | 'INVITE_INVALID'
  | 'VALIDATION_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL'

export class PhoneError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'PhoneError'
  }
}

export const httpStatus: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  NAME_TAKEN: 409,
  INVITE_INVALID: 410,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_ERROR: 422,
  INTERNAL: 500,
}
```

- [ ] **Step 5: Write `src/core/ports.ts`**

```ts
export interface Clock {
  now(): number
}

export type Surface = 'http' | 'mcp' | 'admin'

// a single listen/inbox delivers at most this many messages (stated contract; see design.md)
export const DELIVERY_BATCH_LIMIT = 500

export interface PhoneEvent {
  ts: number
  op: string
  surface: Surface
  agent: string | null
  outcome: 'ok' | 'error'
  errorCode?: string
  durationMs: number
  waitedMs?: number
  threadId?: number
  messageId?: number
  deliveredCount?: number
}

export interface Emitter {
  emit(event: PhoneEvent): void
}

export interface AgentRecord {
  name: string
  tokenHash: string
  status: string | null
  lastSeenAt: number
  createdAt: number
}

export interface InviteRecord {
  id: number
  codeHash: string
  pinnedName: string | null
  expiresAt: number
  usedBy: string | null
  usedAt: number | null
  createdAt: number
}

export interface ThreadRecord {
  id: number
  subject: string
  participantA: string
  participantB: string
  openedBy: string
  status: 'open' | 'ended'
  endedBy: string | null
  endNote: string | null
  openedAt: number
  endedAt: number | null
  lastActivityAt: number
}

export interface MessageRecord {
  id: number
  threadId: number
  sender: string
  recipient: string
  body: string
  kind: 'message' | 'system'
  createdAt: number
}

export interface AgentStore {
  insertAgent(a: AgentRecord): void
  getAgent(name: string): AgentRecord | null
  getAgentByTokenHash(hash: string): AgentRecord | null
  listAgents(): AgentRecord[]
  touchAgent(name: string, ts: number): void
  setAgentStatus(name: string, status: string | null): void
  deleteAgent(name: string): void
}

export interface InviteStore {
  insertInvite(i: Omit<InviteRecord, 'id'>): number
  getInviteByCodeHash(hash: string): InviteRecord | null
  markInviteUsed(id: number, usedBy: string, usedAt: number): void
}

export interface ThreadStore {
  insertThread(t: Omit<ThreadRecord, 'id'>): number
  getThread(id: number): ThreadRecord | null
  listThreadsFor(agent: string): ThreadRecord[]
  updateThread(t: ThreadRecord): void
}

export interface MessageStore {
  insertMessage(m: Omit<MessageRecord, 'id'>): number
  listMessages(threadId: number, afterId: number, limit: number): MessageRecord[]
  listUnacked(recipient: string, afterId: number, limit: number): MessageRecord[]
  maxMessageId(): number
}

export interface CursorStore {
  getCursor(agent: string): number
  setCursor(agent: string, throughId: number): void
}

export type Store = AgentStore & InviteStore & ThreadStore & MessageStore & CursorStore
```

- [ ] **Step 6: Write `src/core/clock.ts`**

```ts
import type { Clock } from './ports.js'

export const systemClock: Clock = { now: () => Date.now() }
```

- [ ] **Step 7: Delete `src/smoke.test.ts`, run tests + typecheck**

Run: `npx vitest run` then `npm run typecheck`
Expected: tokens test PASSES; typecheck clean.

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "feat(core): add error model, ports, clock, and secret tokens"
```

### Task 3: Contracts (zod schemas + types)

**Files:**
- Create: `src/core/contracts.ts`

No dedicated test file — schema behavior is zod's (a dependency); OUR use of the schemas (including the 64KB body cap and the 60s waitMs cap) is exercised by service/http/client tests in later tasks.

- [ ] **Step 1: Write `src/core/contracts.ts`**

```ts
import { z } from 'zod'

export const AgentNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,30}$/, 'lowercase slug, 2-31 chars, a-z 0-9 hyphen')
export const MessageBodySchema = z.string().min(1).max(64 * 1024)
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
  threadId: z.number().int(),
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
  threadId: z.number().int(),
  afterId: z.number().int().default(0),
  limit: z.number().int().min(1).max(500).default(100),
})
export const HistoryOutputSchema = z.object({ messages: z.array(MessageViewSchema) })

export const ThreadsInputSchema = z.object({
  status: z.enum(['open', 'ended', 'all']).default('open'),
})
export const ThreadsOutputSchema = z.object({ threads: z.array(ThreadViewSchema) })

export const HangupInputSchema = z.object({
  threadId: z.number().int(),
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
```

- [ ] **Step 2: Verify typecheck + lint, commit**

Run: `npm run typecheck` then `npm run lint`
Expected: clean.

```powershell
git add src/core/contracts.ts
git commit -m "feat(core): add zod contracts for all verbs"
```

### Task 4: Waiters (long-poll park/notify)

**Files:**
- Create: `src/core/waiters.ts`
- Test: `src/core/waiters.test.ts`

- [ ] **Step 1: Write the failing test** — `src/core/waiters.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { Waiters } from './waiters.js'

describe('Waiters', () => {
  test('notify wakes a parked wait before its timeout', async () => {
    const w = new Waiters()
    const started = Date.now()
    const parked = w.wait('volumi', 5000)
    w.notify('volumi')
    await parked
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('wait resolves on timeout when nobody notifies', async () => {
    const w = new Waiters()
    const started = Date.now()
    await w.wait('volumi', 50)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })

  test('isListening reflects parked waiters', async () => {
    const w = new Waiters()
    expect(w.isListening('volumi')).toBe(false)
    const parked = w.wait('volumi', 2000)
    expect(w.isListening('volumi')).toBe(true)
    w.notify('volumi')
    await parked
    expect(w.isListening('volumi')).toBe(false)
  })

  test('notify only wakes the named agent', async () => {
    const w = new Waiters()
    const other = w.wait('gha-docker-runner', 120)
    w.notify('volumi')
    expect(w.isListening('gha-docker-runner')).toBe(true)
    await other
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/waiters.test.ts`
Expected: FAIL — cannot find module `./waiters.js`

- [ ] **Step 3: Write `src/core/waiters.ts`**

```ts
// in-process long-poll registry: one Set of wakeup callbacks per agent name
export class Waiters {
  private readonly parked = new Map<string, Set<() => void>>()

  isListening(agent: string): boolean {
    return (this.parked.get(agent)?.size ?? 0) > 0
  }

  notify(agent: string): void {
    const set = this.parked.get(agent)
    if (!set) return
    for (const wake of [...set]) wake()
  }

  wait(agent: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.parked.get(agent) ?? new Set<() => void>()
      this.parked.set(agent, set)
      const wake = (): void => {
        set.delete(wake)
        if (set.size === 0) this.parked.delete(agent)
        clearTimeout(timer)
        resolve()
      }
      set.add(wake)
      const timer = setTimeout(wake, ms)
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/waiters.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```powershell
git add src/core/waiters.ts src/core/waiters.test.ts
git commit -m "feat(core): add long-poll waiters with park, notify, and listening flag"
```

### Task 5: SqliteStore

**Files:**
- Create: `src/store/sqlite.ts`
- Test: `src/store/sqlite.test.ts`

Only the nontrivial queries get direct tests (`listUnacked` filtering + limit, `listThreadsFor` on both columns, cursor upsert, `maxMessageId`); plain CRUD is exercised through service tests.

- [ ] **Step 1: Write the failing test** — `src/store/sqlite.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { SqliteStore } from './sqlite.js'

const msg = (threadId: number, sender: string, recipient: string, body: string) => ({
  threadId,
  sender,
  recipient,
  body,
  kind: 'message' as const,
  createdAt: 1000,
})

const thread = (a: string, b: string, subject: string) => ({
  subject,
  participantA: a,
  participantB: b,
  openedBy: a,
  status: 'open' as const,
  endedBy: null,
  endNote: null,
  openedAt: 1000,
  endedAt: null,
  lastActivityAt: 1000,
})

describe('SqliteStore', () => {
  test('listUnacked filters by recipient and afterId, in id order, respecting limit', () => {
    const s = new SqliteStore(':memory:')
    const t1 = s.insertThread(thread('a-1', 'b-1', 'one'))
    const t2 = s.insertThread(thread('a-1', 'b-1', 'two'))
    const m1 = s.insertMessage(msg(t1, 'a-1', 'b-1', 'first'))
    const m2 = s.insertMessage(msg(t2, 'a-1', 'b-1', 'second'))
    const m3 = s.insertMessage(msg(t1, 'b-1', 'a-1', 'reply'))

    expect(s.listUnacked('b-1', 0, 500).map((m) => m.id)).toEqual([m1, m2])
    expect(s.listUnacked('b-1', m1, 500).map((m) => m.id)).toEqual([m2])
    expect(s.listUnacked('b-1', 0, 1).map((m) => m.id)).toEqual([m1])
    expect(s.listUnacked('a-1', 0, 500).map((m) => m.id)).toEqual([m3])
    expect(s.listUnacked('a-1', m3, 500)).toEqual([])
  })

  test('listThreadsFor matches either participant column, newest activity first', () => {
    const s = new SqliteStore(':memory:')
    const t1 = s.insertThread({ ...thread('a-1', 'b-1', 'one'), lastActivityAt: 1000 })
    const t2 = s.insertThread({ ...thread('c-1', 'a-1', 'two'), lastActivityAt: 2000 })
    s.insertThread(thread('c-1', 'b-1', 'not-mine'))
    expect(s.listThreadsFor('a-1').map((t) => t.id)).toEqual([t2, t1])
  })

  test('cursor defaults to 0 and upserts', () => {
    const s = new SqliteStore(':memory:')
    expect(s.getCursor('a-1')).toBe(0)
    s.setCursor('a-1', 5)
    s.setCursor('a-1', 9)
    expect(s.getCursor('a-1')).toBe(9)
  })

  test('maxMessageId is 0 when empty and tracks inserts', () => {
    const s = new SqliteStore(':memory:')
    expect(s.maxMessageId()).toBe(0)
    const t1 = s.insertThread(thread('a-1', 'b-1', 'one'))
    const id = s.insertMessage(msg(t1, 'a-1', 'b-1', 'x'))
    expect(s.maxMessageId()).toBe(id)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/sqlite.test.ts`
Expected: FAIL — cannot find module `./sqlite.js`

- [ ] **Step 3: Write `src/store/sqlite.ts`**

```ts
import Database from 'better-sqlite3'
import type {
  AgentRecord,
  InviteRecord,
  MessageRecord,
  Store,
  ThreadRecord,
} from '../core/ports.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL UNIQUE,
  status TEXT,
  lastSeenAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codeHash TEXT NOT NULL UNIQUE,
  pinnedName TEXT,
  expiresAt INTEGER NOT NULL,
  usedBy TEXT,
  usedAt INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  participantA TEXT NOT NULL,
  participantB TEXT NOT NULL,
  openedBy TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','ended')),
  endedBy TEXT,
  endNote TEXT,
  openedAt INTEGER NOT NULL,
  endedAt INTEGER,
  lastActivityAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  threadId INTEGER NOT NULL REFERENCES threads(id),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message','system')),
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  agent TEXT PRIMARY KEY,
  ackedThroughMessageId INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient, id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId, id);
CREATE INDEX IF NOT EXISTS idx_threads_a ON threads(participantA);
CREATE INDEX IF NOT EXISTS idx_threads_b ON threads(participantB);
`

export class SqliteStore implements Store {
  private readonly db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  // agents
  insertAgent(a: AgentRecord): void {
    this.db
      .prepare(
        'INSERT INTO agents (name, tokenHash, status, lastSeenAt, createdAt) VALUES (@name, @tokenHash, @status, @lastSeenAt, @createdAt)',
      )
      .run(a)
  }
  getAgent(name: string): AgentRecord | null {
    return (
      (this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRecord | undefined) ??
      null
    )
  }
  getAgentByTokenHash(hash: string): AgentRecord | null {
    return (
      (this.db.prepare('SELECT * FROM agents WHERE tokenHash = ?').get(hash) as
        | AgentRecord
        | undefined) ?? null
    )
  }
  listAgents(): AgentRecord[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY name').all() as AgentRecord[]
  }
  touchAgent(name: string, ts: number): void {
    this.db.prepare('UPDATE agents SET lastSeenAt = ? WHERE name = ?').run(ts, name)
  }
  setAgentStatus(name: string, status: string | null): void {
    this.db.prepare('UPDATE agents SET status = ? WHERE name = ?').run(status, name)
  }
  deleteAgent(name: string): void {
    this.db.prepare('DELETE FROM agents WHERE name = ?').run(name)
  }

  // invites
  insertInvite(i: Omit<InviteRecord, 'id'>): number {
    const info = this.db
      .prepare(
        'INSERT INTO invites (codeHash, pinnedName, expiresAt, usedBy, usedAt, createdAt) VALUES (@codeHash, @pinnedName, @expiresAt, @usedBy, @usedAt, @createdAt)',
      )
      .run(i)
    return Number(info.lastInsertRowid)
  }
  getInviteByCodeHash(hash: string): InviteRecord | null {
    return (
      (this.db.prepare('SELECT * FROM invites WHERE codeHash = ?').get(hash) as
        | InviteRecord
        | undefined) ?? null
    )
  }
  markInviteUsed(id: number, usedBy: string, usedAt: number): void {
    this.db.prepare('UPDATE invites SET usedBy = ?, usedAt = ? WHERE id = ?').run(usedBy, usedAt, id)
  }

  // threads
  insertThread(t: Omit<ThreadRecord, 'id'>): number {
    const info = this.db
      .prepare(
        'INSERT INTO threads (subject, participantA, participantB, openedBy, status, endedBy, endNote, openedAt, endedAt, lastActivityAt) VALUES (@subject, @participantA, @participantB, @openedBy, @status, @endedBy, @endNote, @openedAt, @endedAt, @lastActivityAt)',
      )
      .run(t)
    return Number(info.lastInsertRowid)
  }
  getThread(id: number): ThreadRecord | null {
    return (
      (this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRecord | undefined) ??
      null
    )
  }
  listThreadsFor(agent: string): ThreadRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM threads WHERE participantA = ? OR participantB = ? ORDER BY lastActivityAt DESC, id DESC',
      )
      .all(agent, agent) as ThreadRecord[]
  }
  updateThread(t: ThreadRecord): void {
    this.db
      .prepare(
        'UPDATE threads SET subject = @subject, status = @status, endedBy = @endedBy, endNote = @endNote, endedAt = @endedAt, lastActivityAt = @lastActivityAt WHERE id = @id',
      )
      .run(t)
  }

  // messages
  insertMessage(m: Omit<MessageRecord, 'id'>): number {
    const info = this.db
      .prepare(
        'INSERT INTO messages (threadId, sender, recipient, body, kind, createdAt) VALUES (@threadId, @sender, @recipient, @body, @kind, @createdAt)',
      )
      .run(m)
    return Number(info.lastInsertRowid)
  }
  listMessages(threadId: number, afterId: number, limit: number): MessageRecord[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE threadId = ? AND id > ? ORDER BY id LIMIT ?')
      .all(threadId, afterId, limit) as MessageRecord[]
  }
  listUnacked(recipient: string, afterId: number, limit: number): MessageRecord[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE recipient = ? AND id > ? ORDER BY id LIMIT ?')
      .all(recipient, afterId, limit) as MessageRecord[]
  }
  maxMessageId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get() as {
      m: number
    }
    return row.m
  }

  // cursors
  getCursor(agent: string): number {
    const row = this.db
      .prepare('SELECT ackedThroughMessageId FROM cursors WHERE agent = ?')
      .get(agent) as { ackedThroughMessageId: number } | undefined
    return row?.ackedThroughMessageId ?? 0
  }
  setCursor(agent: string, throughId: number): void {
    this.db
      .prepare(
        'INSERT INTO cursors (agent, ackedThroughMessageId) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET ackedThroughMessageId = excluded.ackedThroughMessageId',
      )
      .run(agent, throughId)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/sqlite.test.ts`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```powershell
git add src/store
git commit -m "feat(store): add sqlite store with schema and segregated port impl"
```

### Task 6: Emitters, provisioning, test harness, and PhoneService identity verbs

**Files:**
- Create: `src/obs/emitters.ts`, `src/core/provisioning.ts`, `src/testkit/harness.ts`, `src/core/service.ts`
- Test: `src/core/provisioning.test.ts`, `src/core/service.identity.test.ts`

The service is built verb-cluster by verb-cluster across Tasks 6-8, red-green each time. This task lands ONLY: instrumentation (`op`), `authenticate`, `register`, `checkin`, `phonebook`. Conversations/delivery come in Task 7; lifecycle in Task 8.

- [ ] **Step 1: Write `src/obs/emitters.ts`** (MemoryEmitter is needed by every service test; JsonlEmitter's file behavior gets its test in Task 8)

```ts
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Emitter, PhoneEvent } from '../core/ports.js'

// note: synchronous append on the hot path - fine at two-agent scale (see impl.md deferred debt)
export class JsonlEmitter implements Emitter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }
  emit(event: PhoneEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + '\n')
  }
}

export class MemoryEmitter implements Emitter {
  readonly events: PhoneEvent[] = []
  emit(event: PhoneEvent): void {
    this.events.push(event)
  }
}
```

- [ ] **Step 2: Write `src/core/provisioning.ts`** (operator-side use-cases over ports; consumed by the CLI admin commands AND the test harness — no duplication)

```ts
import type { AgentRecord, AgentStore, Clock, InviteStore } from './ports.js'
import { hashSecret, newInviteCode, newToken } from './tokens.js'

export function createInvite(
  store: InviteStore,
  clock: Clock,
  opts: { pinnedName?: string; ttlHours?: number },
): { code: string; expiresAt: number } {
  const code = newInviteCode()
  const expiresAt = clock.now() + (opts.ttlHours ?? 24) * 3600_000
  store.insertInvite({
    codeHash: hashSecret(code),
    pinnedName: opts.pinnedName ?? null,
    expiresAt,
    usedBy: null,
    usedAt: null,
    createdAt: clock.now(),
  })
  return { code, expiresAt }
}

export function addAgent(
  store: AgentStore,
  clock: Clock,
  name: string,
): { name: string; token: string } {
  if (store.getAgent(name)) throw new Error(`agent "${name}" already exists`)
  const token = newToken()
  store.insertAgent({
    name,
    tokenHash: hashSecret(token),
    status: null,
    lastSeenAt: clock.now(),
    createdAt: clock.now(),
  })
  return { name, token }
}

export function revokeAgent(store: AgentStore, name: string): void {
  if (!store.getAgent(name)) throw new Error(`agent "${name}" does not exist`)
  store.deleteAgent(name)
}

export function listAgentRecords(store: AgentStore): AgentRecord[] {
  return store.listAgents()
}
```

- [ ] **Step 3: Write `src/testkit/harness.ts`** (sits ABOVE core — may import core + adapters; core itself never imports outward)

```ts
// test-only harness shared by unit tests (not shipped: tsup bundles only the cli entry)
import { MemoryEmitter } from '../obs/emitters.js'
import { SqliteStore } from '../store/sqlite.js'
import type { Clock } from '../core/ports.js'
import { addAgent, createInvite } from '../core/provisioning.js'
import { PhoneService } from '../core/service.js'

export class FakeClock implements Clock {
  constructor(public t: number = 1_000_000) {}
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
}

export interface Harness {
  service: PhoneService
  store: SqliteStore
  emitter: MemoryEmitter
  clock: FakeClock
}

export function makeService(opts: { ttlMs?: number } = {}): Harness {
  const store = new SqliteStore(':memory:')
  const emitter = new MemoryEmitter()
  const clock = new FakeClock()
  const service = new PhoneService(store, emitter, clock, opts.ttlMs)
  return { service, store, emitter, clock }
}

// provision an agent directly (admin path), returning its bearer token
export function provision(h: Harness, name: string): string {
  return addAgent(h.store, h.clock, name).token
}

// create a live invite directly (admin path), returning the code
export function invite(h: Harness, opts: { pinnedName?: string; ttlHours?: number } = {}): string {
  return createInvite(h.store, h.clock, opts).code
}
```

- [ ] **Step 4: Write the failing tests** — `src/core/provisioning.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { makeService } from '../testkit/harness.js'
import { addAgent, createInvite, revokeAgent } from './provisioning.js'

describe('provisioning', () => {
  test('createInvite produces a code the service accepts once', async () => {
    const h = makeService()
    const { code } = createInvite(h.store, h.clock, {})
    const out = await h.service.register({ name: 'volumi', inviteCode: code }, 'http')
    expect(out.token).toMatch(/^ap_/)
    await expect(h.service.register({ name: 'other', inviteCode: code }, 'http')).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
  })

  test('createInvite honors pinned name and ttl', async () => {
    const h = makeService()
    const { code } = createInvite(h.store, h.clock, { pinnedName: 'lab7', ttlHours: 1 })
    await expect(h.service.register({ name: 'volumi', inviteCode: code }, 'http')).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
    h.clock.advance(3600_001)
    await expect(h.service.register({ name: 'lab7', inviteCode: code }, 'http')).rejects.toMatchObject({
      code: 'INVITE_INVALID',
    })
  })

  test('addAgent mints a working token; revokeAgent kills it', () => {
    const h = makeService()
    const { token } = addAgent(h.store, h.clock, 'volumi')
    expect(h.service.authenticate(token, 'http').name).toBe('volumi')
    revokeAgent(h.store, 'volumi')
    expect(() => h.service.authenticate(token, 'http')).toThrow()
  })

  test('addAgent rejects a taken name', () => {
    const h = makeService()
    addAgent(h.store, h.clock, 'volumi')
    expect(() => addAgent(h.store, h.clock, 'volumi')).toThrow(/already/)
  })
})
```

and `src/core/service.identity.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { invite, makeService, provision } from '../testkit/harness.js'
import { PhoneError } from './errors.js'

describe('register (invite lifecycle)', () => {
  test('valid invite mints an ap_ token and the agent appears in the phonebook', async () => {
    const h = makeService()
    const code = invite(h)
    const out = await h.service.register({ name: 'volumi', inviteCode: code }, 'http')
    expect(out.token).toMatch(/^ap_/)
    provision(h, 'viewer')
    const book = await h.service.phonebook({ agent: 'viewer', surface: 'http' })
    expect(book.agents.map((a) => a.name)).toContain('volumi')
  })

  test('an expired invite is rejected', async () => {
    const h = makeService()
    const code = invite(h, { ttlHours: 1 })
    h.clock.advance(3600_001)
    await expect(h.service.register({ name: 'volumi', inviteCode: code }, 'http')).rejects.toMatchObject(
      { code: 'INVITE_INVALID' },
    )
  })

  test('a taken name is rejected with NAME_TAKEN', async () => {
    const h = makeService()
    provision(h, 'volumi')
    const code = invite(h)
    await expect(h.service.register({ name: 'volumi', inviteCode: code }, 'http')).rejects.toMatchObject(
      { code: 'NAME_TAKEN' },
    )
  })
})

describe('authenticate', () => {
  test('valid token resolves the agent and bumps lastSeenAt', () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    h.clock.advance(5000)
    const agent = h.service.authenticate(token, 'http')
    expect(agent.name).toBe('volumi')
    expect(h.store.getAgent('volumi')?.lastSeenAt).toBe(h.clock.now())
  })

  test('missing or bad token throws UNAUTHORIZED and emits one auth error event with the right surface', () => {
    const h = makeService()
    expect(() => h.service.authenticate(undefined, 'http')).toThrow(PhoneError)
    expect(() => h.service.authenticate('ap_wrong', 'mcp')).toThrow(PhoneError)
    const authEvents = h.emitter.events.filter((e) => e.op === 'auth')
    expect(authEvents).toHaveLength(2)
    expect(authEvents.map((e) => e.surface)).toEqual(['http', 'mcp'])
    expect(authEvents.every((e) => e.outcome === 'error')).toBe(true)
  })
})

describe('checkin + phonebook', () => {
  test('checkin sets the status text shown in the phonebook; omitting status preserves it', async () => {
    const h = makeService()
    provision(h, 'volumi')
    provision(h, 'gha-docker-runner')
    await h.service.checkin(
      { agent: 'volumi', surface: 'http' },
      { status: 'iterating on CI retries' },
    )
    await h.service.checkin({ agent: 'volumi', surface: 'http' }, {})
    const book = await h.service.phonebook({ agent: 'gha-docker-runner', surface: 'http' })
    expect(book.agents.find((a) => a.name === 'volumi')?.status).toBe('iterating on CI retries')
  })
})
```

(Invite single-use and pinned-name rejection live in `provisioning.test.ts` — not duplicated here. The phonebook `listening` flag test arrives in Task 7 with `listen`.)

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run src/core/provisioning.test.ts src/core/service.identity.test.ts`
Expected: FAIL — cannot find module `./service.js`

- [ ] **Step 6: Write `src/core/service.ts`** (identity verbs only — Tasks 7-8 add the rest)

```ts
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
      agents: this.store.listAgents().map(
        (a): AgentView => ({
          name: a.name,
          status: a.status,
          lastSeenAt: a.lastSeenAt,
          listening: this.waiters.isListening(a.name),
        }),
      ),
    }))
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/core/provisioning.test.ts src/core/service.identity.test.ts`
Expected: all PASS

- [ ] **Step 8: Full suite + typecheck + lint, commit**

```powershell
npm test
npm run typecheck
npm run lint
git add src/core src/obs src/testkit
git commit -m "feat(core): add identity verbs, provisioning use-cases, and canonical instrumentation"
```

### Task 7: PhoneService — conversations & delivery (call, send, listen, ack)

**Files:**
- Modify: `src/core/service.ts` (add methods)
- Test: `src/core/service.delivery.test.ts`

**Clock rule for this task:** the long-poll window in `listen` is wall-clock (`Date.now()`), matching `Waiters`' real timers — the injected `Clock` (a FakeClock in tests) would freeze the deadline and make the timeout branch unreachable. The injected `Clock` still stamps `createdAt`/`lastActivityAt`/event `ts`. Long-poll tests therefore use small REAL waits (≤ a few hundred ms).

- [ ] **Step 1: Write the failing test** — `src/core/service.delivery.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { makeService, provision } from '../testkit/harness.js'

const gha = { agent: 'gha-docker-runner', surface: 'http' as const }
const vol = { agent: 'volumi', surface: 'http' as const }

function twoAgents() {
  const h = makeService()
  provision(h, 'gha-docker-runner')
  provision(h, 'volumi')
  return h
}

describe('call', () => {
  test('creates an open thread and delivers the optional first message', async () => {
    const h = twoAgents()
    const out = await h.service.call(gha, { to: 'volumi', subject: 'ci retries', body: 'hello' })
    expect(out.thread.status).toBe('open')
    expect(out.message?.recipient).toBe('volumi')
    const inbox = await h.service.listen(vol, { waitMs: 0 })
    expect(inbox.messages.map((m) => m.body)).toEqual(['hello'])
  })

  test('calling an unknown agent is NOT_FOUND; calling yourself is VALIDATION_ERROR', async () => {
    const h = twoAgents()
    await expect(h.service.call(gha, { to: 'nobody', subject: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      h.service.call(gha, { to: 'gha-docker-runner', subject: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('send', () => {
  test('a non-participant cannot send into a thread', async () => {
    const h = twoAgents()
    provision(h, 'intruder')
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'private' })
    await expect(
      h.service.send({ agent: 'intruder', surface: 'http' }, { threadId: thread.id, body: 'hi' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('at-least-once delivery', () => {
  test('unacked messages are re-delivered until acked; ack stops redelivery', async () => {
    const h = twoAgents()
    await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'important' })
    const first = await h.service.listen(vol, { waitMs: 0 })
    const second = await h.service.listen(vol, { waitMs: 0 })
    expect(first.messages).toEqual(second.messages) // no silent consumption
    await h.service.ack(vol, { throughMessageId: second.cursor })
    const third = await h.service.listen(vol, { waitMs: 0 })
    expect(third.messages).toEqual([])
  })

  test('ack is idempotent, never regresses, and caps at the max message id', async () => {
    const h = twoAgents()
    await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'm1' })
    const { cursor } = await h.service.listen(vol, { waitMs: 0 })
    const acked = await h.service.ack(vol, { throughMessageId: cursor })
    expect(acked.ackedThroughMessageId).toBe(cursor)
    expect((await h.service.ack(vol, { throughMessageId: 0 })).ackedThroughMessageId).toBe(cursor)
    expect((await h.service.ack(vol, { throughMessageId: 999_999 })).ackedThroughMessageId).toBe(
      h.store.maxMessageId(),
    )
  })
})

describe('listen long-poll', () => {
  test('returns immediately when unacked messages already exist', async () => {
    const h = twoAgents()
    await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'waiting for you' })
    const out = await h.service.listen(vol, { waitMs: 5000 })
    expect(out.messages).toHaveLength(1)
    const ev = h.emitter.events.find((e) => e.op === 'listen')
    expect(ev?.deliveredCount).toBe(1)
  })

  test('parks until a send wakes it', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci' })
    const parked = h.service.listen(vol, { waitMs: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    await h.service.send(gha, { threadId: thread.id, body: 'ping' })
    const out = await parked
    expect(out.messages.map((m) => m.body)).toEqual(['ping'])
  })

  test('times out empty when nothing arrives, leaving the cursor unchanged', async () => {
    const h = twoAgents()
    const before = h.store.getCursor('volumi')
    const out = await h.service.listen(vol, { waitMs: 150 })
    expect(out.messages).toEqual([])
    expect(out.cursor).toBe(before)
  })

  test('phonebook reports listening=true while a listen is parked', async () => {
    const h = twoAgents()
    const parked = h.service.listen(vol, { waitMs: 400 })
    await new Promise((r) => setTimeout(r, 50))
    const book = await h.service.phonebook(gha)
    expect(book.agents.find((a) => a.name === 'volumi')?.listening).toBe(true)
    await parked
    const after = await h.service.phonebook(gha)
    expect(after.agents.find((a) => a.name === 'volumi')?.listening).toBe(false)
  })
})

describe('canonical events', () => {
  test('every operation emits exactly one event, including failures', async () => {
    const h = twoAgents()
    h.emitter.events.length = 0
    await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'm1' })
    await h.service.listen(vol, { waitMs: 0 })
    await h.service.ack(vol, { throughMessageId: 1 })
    await h.service.call(gha, { to: 'nobody', subject: 'x' }).catch(() => undefined)
    const ops = h.emitter.events.map((e) => `${e.op}:${e.outcome}`)
    expect(ops).toEqual(['call:ok', 'listen:ok', 'ack:ok', 'call:error'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/service.delivery.test.ts`
Expected: FAIL — `h.service.call is not a function`

- [ ] **Step 3: Add the conversation/delivery methods to `src/core/service.ts`**

Add these imports to the existing import block:

```ts
import type {
  AckInput,
  AckOutput,
  CallInput,
  CallOutput,
  ListenInput,
  ListenOutput,
  MessageView,
  SendInput,
  SendOutput,
  ThreadView,
} from './contracts.js'
import { DELIVERY_BATCH_LIMIT } from './ports.js'
import type { MessageRecord, ThreadRecord } from './ports.js'
```

Add these methods to the `PhoneService` class:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/service.delivery.test.ts`
Expected: all PASS

- [ ] **Step 5: Full suite, commit**

```powershell
npm test
git add src/core/service.ts src/core/service.delivery.test.ts
git commit -m "feat(core): add conversations and at-least-once delivery with wall-clock long-poll"
```

### Task 8: PhoneService — lifecycle (hangup, threads, history) + TTL + JsonlEmitter

**Files:**
- Modify: `src/core/service.ts` (add methods)
- Test: `src/core/service.lifecycle.test.ts`

- [ ] **Step 1: Write the failing test** — `src/core/service.lifecycle.test.ts`

```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { JsonlEmitter } from '../obs/emitters.js'
import { makeService, provision } from '../testkit/harness.js'
import type { PhoneEvent } from './ports.js'

const HOUR = 3600_000
const gha = { agent: 'gha-docker-runner', surface: 'http' as const }
const vol = { agent: 'volumi', surface: 'http' as const }

function twoAgents() {
  const h = makeService()
  provision(h, 'gha-docker-runner')
  provision(h, 'volumi')
  return h
}

describe('hangup', () => {
  test('ends the thread and delivers the note as a system message', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci' })
    const out = await h.service.hangup(gha, { threadId: thread.id, note: 'all fixed, thanks' })
    expect(out.thread.status).toBe('ended')
    expect(out.thread.endedBy).toBe('gha-docker-runner')
    const inbox = await h.service.listen(vol, { waitMs: 0 })
    expect(inbox.messages.at(-1)).toMatchObject({ kind: 'system', body: 'all fixed, thanks' })
  })
})

describe('threads + reopen-on-send', () => {
  test('sending to an ended thread reopens it', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci' })
    await h.service.hangup(gha, { threadId: thread.id })
    expect((await h.service.threads(gha, { status: 'ended' })).threads.map((t) => t.id)).toEqual([
      thread.id,
    ])
    await h.service.send(vol, { threadId: thread.id, body: 'one more thing' })
    expect((await h.service.threads(gha, { status: 'open' })).threads.map((t) => t.id)).toEqual([
      thread.id,
    ])
  })

  test('an idle open thread reads as ended after the TTL and revives on send', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci' })
    h.clock.advance(24 * HOUR + 1)
    expect((await h.service.threads(gha, { status: 'open' })).threads).toEqual([])
    expect((await h.service.threads(gha, { status: 'ended' })).threads.map((t) => t.id)).toEqual([
      thread.id,
    ])
    await h.service.send(gha, { threadId: thread.id, body: 'still there?' })
    expect((await h.service.threads(gha, { status: 'open' })).threads.map((t) => t.id)).toEqual([
      thread.id,
    ])
  })
})

describe('history', () => {
  test('pages by afterId and rejects non-participants', async () => {
    const h = twoAgents()
    const { thread } = await h.service.call(gha, { to: 'volumi', subject: 'ci', body: 'm1' })
    await h.service.send(vol, { threadId: thread.id, body: 'm2' })
    await h.service.send(gha, { threadId: thread.id, body: 'm3' })
    const all = await h.service.history(gha, { threadId: thread.id, afterId: 0, limit: 100 })
    expect(all.messages.map((m) => m.body)).toEqual(['m1', 'm2', 'm3'])
    const firstId = all.messages[0]?.id ?? 0
    const rest = await h.service.history(gha, { threadId: thread.id, afterId: firstId, limit: 100 })
    expect(rest.messages.map((m) => m.body)).toEqual(['m2', 'm3'])
    provision(h, 'intruder')
    await expect(
      h.service.history(
        { agent: 'intruder', surface: 'http' },
        { threadId: thread.id, afterId: 0, limit: 100 },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('JsonlEmitter', () => {
  test('writes one JSON line per event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentphone-'))
    const path = join(dir, 'events.jsonl')
    const emitter = new JsonlEmitter(path)
    const event: PhoneEvent = {
      ts: 1,
      op: 'call',
      surface: 'http',
      agent: 'volumi',
      outcome: 'ok',
      durationMs: 2,
    }
    emitter.emit(event)
    emitter.emit({ ...event, op: 'ack' })
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ op: 'call' })
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ op: 'ack' })
  })
})
```

(The reopen-on-send *code* landed with `send` in Task 7 as an unconditional write; the test here is the red-green for the observable contract, which needs `hangup`/`threads` to exist — they don't yet, so this file fails for the right reason.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/service.lifecycle.test.ts`
Expected: FAIL — `h.service.hangup is not a function`

- [ ] **Step 3: Add the lifecycle methods to `src/core/service.ts`**

Add these imports to the existing contracts import:

```ts
import type {
  HangupInput,
  HangupOutput,
  HistoryInput,
  HistoryOutput,
  ThreadsInput,
  ThreadsOutput,
} from './contracts.js'
```

Add these methods to the `PhoneService` class:

```ts
  hangup(ctx: CallCtx, input: HangupInput): Promise<HangupOutput> {
    return this.op('hangup', ctx.surface, ctx.agent, (ev) => {
      const thread = this.requireParticipant(input.threadId, ctx.agent)
      const now = this.clock.now()
      const other = this.otherParticipant(thread, ctx.agent)
      if (input.note !== undefined) {
        const id = this.store.insertMessage({
          threadId: thread.id,
          sender: ctx.agent,
          recipient: other,
          body: input.note,
          kind: 'system',
          createdAt: now,
        })
        ev.messageId = id
        this.waiters.notify(other)
      }
      const ended = {
        ...thread,
        status: 'ended' as const,
        endedBy: ctx.agent,
        endNote: input.note ?? null,
        endedAt: now,
        lastActivityAt: now,
      }
      this.store.updateThread(ended)
      ev.threadId = thread.id
      return { thread: this.toThreadView(ended) }
    })
  }

  threads(ctx: CallCtx, input: ThreadsInput): Promise<ThreadsOutput> {
    return this.op('threads', ctx.surface, ctx.agent, () => {
      const all = this.store.listThreadsFor(ctx.agent).map((t) => this.toThreadView(t))
      const filtered = input.status === 'all' ? all : all.filter((t) => t.status === input.status)
      return { threads: filtered }
    })
  }

  history(ctx: CallCtx, input: HistoryInput): Promise<HistoryOutput> {
    return this.op('history', ctx.surface, ctx.agent, (ev) => {
      const thread = this.requireParticipant(input.threadId, ctx.agent)
      ev.threadId = thread.id
      return {
        messages: this.store
          .listMessages(thread.id, input.afterId, input.limit)
          .map((m) => this.toMessageView(m)),
      }
    })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/service.lifecycle.test.ts`
Expected: all PASS

- [ ] **Step 5: Full suite + typecheck + lint, commit**

```powershell
npm test
npm run typecheck
npm run lint
git add src/core/service.ts src/core/service.lifecycle.test.ts
git commit -m "feat(core): add thread lifecycle with lazy ttl and hangup system notes"
```

**Phase 1 checkpoint (per project CLAUDE.md):** dispatch parallel spec-conformance + code-quality reviews of `src/core` + `src/store` + `src/testkit` before starting Phase 2. Fix HIGH/MEDIUM findings before continuing.

---

## Phase 2 — HTTP surface

### Task 9: Config loaders

**Files:**
- Create: `src/core/config.ts`
- Test: `src/core/config.test.ts`

- [ ] **Step 1: Write the failing test** — `src/core/config.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { loadClientConfig, loadServerConfig } from './config.js'

describe('loadServerConfig', () => {
  test('applies effective defaults', () => {
    const cfg = loadServerConfig({})
    expect(cfg).toEqual({
      port: 4747,
      bind: '127.0.0.1',
      dbPath: './agentphone.db',
      eventsPath: './agentphone.events.jsonl',
      threadTtlHours: 24,
    })
  })

  test('reads AGENTPHONE_* overrides and rejects junk numbers', () => {
    const cfg = loadServerConfig({
      AGENTPHONE_PORT: '8080',
      AGENTPHONE_BIND: '0.0.0.0',
      AGENTPHONE_DB: 'x.db',
      AGENTPHONE_EVENTS: 'x.jsonl',
      AGENTPHONE_THREAD_TTL_HOURS: '48',
    })
    expect(cfg.port).toBe(8080)
    expect(cfg.bind).toBe('0.0.0.0')
    expect(cfg.threadTtlHours).toBe(48)
    expect(() => loadServerConfig({ AGENTPHONE_PORT: 'lots' })).toThrow(/AGENTPHONE_PORT/)
  })
})

describe('loadClientConfig', () => {
  test('fails fast, naming the missing variable', () => {
    expect(() => loadClientConfig({})).toThrow(/AGENTPHONE_URL/)
    expect(() => loadClientConfig({ AGENTPHONE_URL: 'http://x:4747' })).toThrow(/AGENTPHONE_TOKEN/)
    expect(
      loadClientConfig({ AGENTPHONE_URL: 'http://x:4747', AGENTPHONE_TOKEN: 'ap_t' }),
    ).toEqual({ url: 'http://x:4747', token: 'ap_t' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/config.test.ts`
Expected: FAIL — cannot find module `./config.js`

- [ ] **Step 3: Write `src/core/config.ts`**

```ts
export interface ServerConfig {
  port: number
  bind: string
  dbPath: string
  eventsPath: string
  threadTtlHours: number
}

export interface ClientConfig {
  url: string
  token: string
}

type Env = Record<string, string | undefined>

function intFrom(env: Env, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${key} must be a non-negative integer, got "${raw}"`)
  return n
}

export function loadServerConfig(env: Env): ServerConfig {
  return {
    port: intFrom(env, 'AGENTPHONE_PORT', 4747),
    bind: env.AGENTPHONE_BIND ?? '127.0.0.1',
    dbPath: env.AGENTPHONE_DB ?? './agentphone.db',
    eventsPath: env.AGENTPHONE_EVENTS ?? './agentphone.events.jsonl',
    threadTtlHours: intFrom(env, 'AGENTPHONE_THREAD_TTL_HOURS', 24),
  }
}

export function loadClientConfig(env: Env): ClientConfig {
  const url = env.AGENTPHONE_URL
  if (!url) throw new Error('AGENTPHONE_URL is required (e.g. http://100.110.150.142:4747)')
  const token = env.AGENTPHONE_TOKEN
  if (!token) throw new Error('AGENTPHONE_TOKEN is required (mint one via invite or admin add)')
  return { url, token }
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run src/core/config.test.ts` — expected: all PASS

```powershell
git add src/core/config.ts src/core/config.test.ts
git commit -m "feat(core): add fail-fast config loaders with effective defaults"
```

### Task 10: Express app + startServer

**Files:**
- Create: `src/http/app.ts`, `src/http/server.ts`
- Test: `src/http/app.test.ts`

Design points enforced here (from the plan-review gate):
- `buildApp` takes an OPTIONAL injected `mcpHandler` — `src/http` never imports `src/mcp`. The composition root (`server.ts`) wires them together in Task 11.
- Auth middleware is a factory `auth(surface)` so MCP auth failures carry `surface: 'mcp'`.
- Boundary rejections (zod 422, payload-too-large 413) emit a canonical event — every request yields exactly one event. `PhoneError`s do NOT re-emit (the service's `op()` already did).

- [ ] **Step 1: Write the failing test** — `src/http/app.test.ts`

```ts
import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { invite, makeService, provision, type Harness } from '../testkit/harness.js'
import { buildApp } from './app.js'

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function boot(h: Harness): Promise<string> {
  const app = buildApp({ service: h.service, emitter: h.emitter, clock: h.clock })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server?.address()
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port')
  return `http://127.0.0.1:${addr.port}`
}

const asJson = (r: Response): Promise<unknown> => r.json() as Promise<unknown>

describe('http surface', () => {
  test('health is public; everything else requires a valid bearer token', async () => {
    const h = makeService()
    const base = await boot(h)
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/agents`)).status).toBe(401)
    const bad = await fetch(`${base}/api/agents`, { headers: { authorization: 'Bearer nope' } })
    expect(bad.status).toBe(401)
    expect(await asJson(bad)).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  test('register over http mints a token that then authenticates', async () => {
    const h = makeService()
    const code = invite(h)
    const base = await boot(h)
    const res = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'volumi', inviteCode: code }),
    })
    expect(res.status).toBe(201)
    const { token } = (await asJson(res)) as { token: string }
    const agents = await fetch(`${base}/api/agents`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(agents.status).toBe(200)
  })

  test('validation failures return 422 with the single error shape AND emit one canonical event', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    h.emitter.events.length = 0
    const res = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: 'volumi' }), // missing subject
    })
    expect(res.status).toBe(422)
    expect(await asJson(res)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    const boundary = h.emitter.events.filter((e) => e.outcome === 'error')
    expect(boundary).toHaveLength(1)
    expect(boundary[0]).toMatchObject({ op: 'call', errorCode: 'VALIDATION_ERROR', agent: 'volumi' })
  })

  test('a body over the 64KB message cap is rejected with 422', async () => {
    const h = makeService()
    provision(h, 'gha-docker-runner')
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: 'gha-docker-runner',
        subject: 'big',
        body: 'x'.repeat(64 * 1024 + 1),
      }),
    })
    expect(res.status).toBe(422)
  })

  test('a payload beyond the transport limit maps to 413, not 500', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: 'volumi', subject: 'big', body: 'x'.repeat(300 * 1024) }),
    })
    expect(res.status).toBe(413)
    expect(await asJson(res)).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
  })

  test('domain errors map to their statuses (404 unknown thread)', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/calls/999/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: 'hi' }),
    })
    expect(res.status).toBe(404)
    expect(await asJson(res)).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  test('GET /api/inbox long-polls until a message lands', async () => {
    const h = makeService()
    const ghaToken = provision(h, 'gha-docker-runner')
    const volToken = provision(h, 'volumi')
    const base = await boot(h)
    const auth = (t: string) => ({ authorization: `Bearer ${t}` })
    const parked = fetch(`${base}/api/inbox?waitMs=5000`, { headers: auth(volToken) })
    await new Promise((r) => setTimeout(r, 50))
    const call = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(ghaToken) },
      body: JSON.stringify({ to: 'volumi', subject: 'ring', body: 'pick up!' }),
    })
    expect(call.status).toBe(201)
    const inbox = (await asJson(await parked)) as { messages: Array<{ body: string }> }
    expect(inbox.messages.map((m) => m.body)).toEqual(['pick up!'])
  })

  test('cursor ack round-trip over http', async () => {
    const h = makeService()
    const ghaToken = provision(h, 'gha-docker-runner')
    const volToken = provision(h, 'volumi')
    const base = await boot(h)
    const auth = (t: string) => ({ authorization: `Bearer ${t}` })
    await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(ghaToken) },
      body: JSON.stringify({ to: 'volumi', subject: 'ci', body: 'm1' }),
    })
    const got = (await asJson(
      await fetch(`${base}/api/inbox`, { headers: auth(volToken) }),
    )) as { cursor: number }
    const ack = await fetch(`${base}/api/cursor`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(volToken) },
      body: JSON.stringify({ throughMessageId: got.cursor }),
    })
    expect(ack.status).toBe(200)
    const after = (await asJson(
      await fetch(`${base}/api/inbox`, { headers: auth(volToken) }),
    )) as { messages: unknown[] }
    expect(after.messages).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/http/app.test.ts`
Expected: FAIL — cannot find module `./app.js`

- [ ] **Step 3: Write `src/http/app.ts`**

```ts
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
      res.json(await service.hangup({ agent: agentOf(res), surface: 'http' }, { threadId, ...body }))
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
```

- [ ] **Step 4: Write `src/http/server.ts`** (composition root — the MCP handler is wired here in Task 11; for now it passes none)

```ts
import type { AddressInfo } from 'node:net'
import type { ServerConfig } from '../core/config.js'
import { systemClock } from '../core/clock.js'
import { PhoneService } from '../core/service.js'
import { JsonlEmitter } from '../obs/emitters.js'
import { SqliteStore } from '../store/sqlite.js'
import { buildApp } from './app.js'

export interface RunningServer {
  port: number
  close: () => Promise<void>
}

export function startServer(cfg: ServerConfig): Promise<RunningServer> {
  const store = new SqliteStore(cfg.dbPath)
  const emitter = new JsonlEmitter(cfg.eventsPath)
  const service = new PhoneService(store, emitter, systemClock, cfg.threadTtlHours * 3600_000)
  const app = buildApp({ service, emitter, clock: systemClock })
  return new Promise((resolve) => {
    const srv = app.listen(cfg.port, cfg.bind, () => {
      const port = (srv.address() as AddressInfo).port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            srv.close(() => {
              store.close()
              done()
            })
          }),
      })
    })
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/http/app.test.ts`
Expected: all PASS

- [ ] **Step 6: Full suite + typecheck + lint, commit**

```powershell
npm test
npm run typecheck
npm run lint
git add src/http
git commit -m "feat(http): add express surface with per-surface auth, boundary events, and long-poll inbox"
```

---

## Phase 3 — MCP surface

### Task 11: MCP tools + wiring into the composition root

**Files:**
- Create: `src/mcp/tools.ts`
- Modify: `src/http/server.ts` (pass `mcpHandler`)
- Test: `test/mcp.test.ts`

Pin note: if `npm install` resolved an SDK version whose `registerTool` option shape differs (very old versions used `paramsSchema`), check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` and match it; then pin the exact working minor in `package.json`. If `client.connect`/`close` errors on transport verbs, the stateless GET/DELETE 405 handlers in `app.ts` are already in place per the SDK's stateless example.

- [ ] **Step 1: Write the failing test** — `test/mcp.test.ts`

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { makeService, provision } from '../src/testkit/harness.js'
import { buildApp } from '../src/http/app.js'
import { handleMcpRequest } from '../src/mcp/tools.js'

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function boot() {
  const h = makeService()
  const ghaToken = provision(h, 'gha-docker-runner')
  const volToken = provision(h, 'volumi')
  const app = buildApp({
    service: h.service,
    emitter: h.emitter,
    clock: h.clock,
    mcpHandler: handleMcpRequest,
  })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server?.address()
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port')
  return {
    h,
    ghaToken,
    volToken,
    base: `http://127.0.0.1:${addr.port}`,
    url: `http://127.0.0.1:${addr.port}/mcp`,
  }
}

async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'mcp-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

const textOf = (result: { content?: unknown }): string => {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0]?.text ?? ''
}

describe('mcp surface', () => {
  test('lists the ten verbs as tools, with listen defaulting waitMs to 25s', async () => {
    const { url, ghaToken } = await boot()
    const client = await connect(url, ghaToken)
    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['ack', 'call', 'checkin', 'hangup', 'history', 'inbox', 'listen', 'phonebook', 'send', 'threads'].sort(),
    )
    const listen = tools.find((t) => t.name === 'listen')
    // assert the default via the published schema rather than a live 25s call
    expect(JSON.stringify(listen?.inputSchema)).toContain('25000')
    await client.close()
  })

  test('call, send, and listen round-trip across two mcp clients', async () => {
    const { url, ghaToken, volToken } = await boot()
    const gha = await connect(url, ghaToken)
    const vol = await connect(url, volToken)

    const book = await gha.callTool({ name: 'phonebook', arguments: {} })
    expect(textOf(book)).toContain('volumi')

    const call = await gha.callTool({
      name: 'call',
      arguments: { to: 'volumi', subject: 'mcp says hi', body: 'over mcp' },
    })
    const threadId = (JSON.parse(textOf(call)) as { thread: { id: number } }).thread.id

    const got = await vol.callTool({ name: 'listen', arguments: { waitMs: 5000 } })
    expect(textOf(got)).toContain('over mcp')

    await vol.callTool({ name: 'send', arguments: { threadId, body: 'mcp reply' } })
    const reply = await gha.callTool({ name: 'listen', arguments: { waitMs: 5000 } })
    expect(textOf(reply)).toContain('mcp reply')

    await gha.close()
    await vol.close()
  })

  test('domain errors surface as isError tool results, not protocol failures', async () => {
    const { url, ghaToken } = await boot()
    const gha = await connect(url, ghaToken)
    const res = await gha.callTool({ name: 'call', arguments: { to: 'nobody', subject: 'x' } })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('NOT_FOUND')
    await gha.close()
  })

  test('a bad token cannot connect', async () => {
    const { url } = await boot()
    await expect(connect(url, 'ap_wrong')).rejects.toThrow()
  })

  test('GET /mcp returns 405 (stateless server)', async () => {
    const { base, ghaToken } = await boot()
    const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${ghaToken}` } })
    expect(res.status).toBe(405)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcp.test.ts`
Expected: FAIL — cannot find module `../src/mcp/tools.js`

- [ ] **Step 3: Write `src/mcp/tools.ts`**

```ts
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
        body: z.string().min(1).max(64 * 1024).optional(),
      },
    },
    wrap((a: { to: string; subject: string; body?: string }) => service.call(ctx, a)),
  )
  server.registerTool(
    'send',
    {
      description: 'Send a message into an existing thread (reopens an ended thread).',
      inputSchema: { threadId: z.number().int(), body: z.string().min(1).max(64 * 1024) },
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
```

- [ ] **Step 4: Wire the handler in `src/http/server.ts`**

Add the import:

```ts
import { handleMcpRequest } from '../mcp/tools.js'
```

and change the `buildApp` call to:

```ts
  const app = buildApp({ service, emitter, clock: systemClock, mcpHandler: handleMcpRequest })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/mcp.test.ts`
Expected: all PASS

- [ ] **Step 6: Full suite + typecheck + lint, commit**

```powershell
npm test
npm run typecheck
npm run lint
git add src/mcp src/http/server.ts test/mcp.test.ts
git commit -m "feat(mcp): expose the ten verbs as stateless streamable-http tools wired at the composition root"
```

**Phase 2-3 checkpoint (per project CLAUDE.md):** dispatch parallel spec-conformance + code-quality reviews of `src/http` + `src/mcp` before starting Phase 4. Fix HIGH/MEDIUM findings before continuing.

---

## Phase 4 — Client + CLI

### Task 12: PhoneClient

**Files:**
- Create: `src/client/client.ts`
- Test: `src/client/client.test.ts`

- [ ] **Step 1: Write the failing test** — `src/client/client.test.ts`

```ts
import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { invite, makeService, type Harness } from '../testkit/harness.js'
import { buildApp } from '../http/app.js'
import { ClientError, PhoneClient, registerAgent } from './client.js'

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function boot(h: Harness): Promise<string> {
  const app = buildApp({ service: h.service, emitter: h.emitter, clock: h.clock })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server?.address()
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port')
  return `http://127.0.0.1:${addr.port}`
}

describe('PhoneClient', () => {
  test('register → call → inbox → ack → hangup round-trip', async () => {
    const h = makeService()
    const url = await boot(h)
    const gha = await registerAgent(url, { name: 'gha-docker-runner', inviteCode: invite(h) })
    const vol = await registerAgent(url, { name: 'volumi', inviteCode: invite(h) })
    const ghaClient = new PhoneClient({ url, token: gha.token })
    const volClient = new PhoneClient({ url, token: vol.token })

    const book = await ghaClient.phonebook()
    expect(book.agents.map((a) => a.name).sort()).toEqual(['gha-docker-runner', 'volumi'])

    const { thread } = await ghaClient.call({ to: 'volumi', subject: 'ci', body: 'first' })
    await volClient.send({ threadId: thread.id, body: 'reply' })

    const inbox = await volClient.inbox()
    expect(inbox.messages.map((m) => m.body)).toEqual(['first'])
    await volClient.ack(inbox.cursor)
    expect((await volClient.inbox()).messages).toEqual([])

    const ended = await ghaClient.hangup(thread.id, 'done')
    expect(ended.thread.status).toBe('ended')
    const history = await ghaClient.history(thread.id)
    expect(history.messages.map((m) => m.kind)).toEqual(['message', 'message', 'system'])
  })

  test('domain errors surface as ClientError with the server code', async () => {
    const h = makeService()
    const url = await boot(h)
    const me = await registerAgent(url, { name: 'volumi', inviteCode: invite(h) })
    const client = new PhoneClient({ url, token: me.token })
    await expect(client.send({ threadId: 999, body: 'hi' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const bad = new PhoneClient({ url, token: 'ap_wrong' })
    await expect(bad.phonebook()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(bad.phonebook()).rejects.toBeInstanceOf(ClientError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/client/client.test.ts`
Expected: FAIL — cannot find module `./client.js`

- [ ] **Step 3: Write `src/client/client.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run src/client/client.test.ts` — expected: all PASS

```powershell
git add src/client
git commit -m "feat(client): add typed fetch client validating responses against core contracts"
```

### Task 13: CLI command logic (listen loop, exit codes, stdin bodies, --to, --all)

**Files:**
- Create: `src/cli/commands.ts`
- Test: `src/cli/commands.test.ts`

All CLI behavior with any logic lives here as small functions over narrow client interfaces (interface segregation), so `index.ts` stays wiring-only.

- [ ] **Step 1: Write the failing test** — `src/cli/commands.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import type { ListenOutput, MessageView, ThreadView } from '../core/contracts.js'
import {
  ackAll,
  bodyFrom,
  exitCodeFor,
  listenCommand,
  resolvePeerThread,
  sendTo,
  type AckAllClient,
  type ListenClient,
  type SendToClient,
} from './commands.js'

const msg = (id: number, body: string): MessageView => ({
  id,
  threadId: 1,
  sender: 'gha-docker-runner',
  recipient: 'volumi',
  body,
  kind: 'message',
  createdAt: 1000,
})

const threadView = (
  id: number,
  subject: string,
  status: 'open' | 'ended',
  participants: [string, string] = ['gha-docker-runner', 'volumi'],
): ThreadView => ({
  id,
  subject,
  participants,
  openedBy: participants[0],
  status,
  endedBy: null,
  endNote: null,
  openedAt: 1000,
  lastActivityAt: 1000,
})

describe('resolvePeerThread', () => {
  test('resolves the single open thread with the peer, excluding other peers', () => {
    const threads = [
      threadView(1, 'ci', 'open'),
      threadView(2, 'old', 'ended'),
      threadView(3, 'other-peer', 'open', ['gha-docker-runner', 'lab7']),
    ]
    expect(resolvePeerThread(threads, 'volumi')).toBe(1)
  })
  test('errors helpfully when there is no open thread', () => {
    expect(() => resolvePeerThread([], 'volumi')).toThrow(/agentphone call volumi/)
  })
  test('errors listing candidates when ambiguous', () => {
    const threads = [threadView(1, 'ci', 'open'), threadView(2, 'infra', 'open')]
    expect(() => resolvePeerThread(threads, 'volumi')).toThrow(/#1.*#2/s)
  })
})

describe('listenCommand', () => {
  test('prints and returns on delivery; reminds about ack when not auto-acking', async () => {
    const inboxes: ListenOutput[] = [
      { messages: [], cursor: 0 },
      { messages: [msg(7, 'ping')], cursor: 7 },
    ]
    const acked: number[] = []
    const client: ListenClient = {
      inbox: () => Promise.resolve(inboxes.shift() ?? { messages: [], cursor: 0 }),
      ack: (through) => {
        acked.push(through)
        return Promise.resolve({ ackedThroughMessageId: through })
      },
    }
    const out: string[] = []
    const result = await listenCommand(client, { waitSeconds: 5, autoAck: false }, (s) => out.push(s))
    expect(result).toBe('delivered')
    expect(out.join('\n')).toContain('ping')
    expect(out.join('\n')).toContain('ack --through 7')
    expect(acked).toEqual([])
  })

  test('auto-acks when --ack is set', async () => {
    const acked: number[] = []
    const client: ListenClient = {
      inbox: () => Promise.resolve({ messages: [msg(3, 'hi')], cursor: 3 }),
      ack: (through) => {
        acked.push(through)
        return Promise.resolve({ ackedThroughMessageId: through })
      },
    }
    const result = await listenCommand(client, { waitSeconds: 5, autoAck: true }, () => undefined)
    expect(result).toBe('delivered')
    expect(acked).toEqual([3])
  })

  test('returns timeout when the window closes empty', async () => {
    const client: ListenClient = {
      inbox: () => Promise.resolve({ messages: [], cursor: 0 }),
      ack: () => Promise.resolve({ ackedThroughMessageId: 0 }),
    }
    const out: string[] = []
    const result = await listenCommand(client, { waitSeconds: 0, autoAck: false }, (s) => out.push(s))
    expect(result).toBe('timeout')
    expect(out.join('\n')).toMatch(/no messages/i)
  })
})

describe('exitCodeFor', () => {
  test('delivered=0, timeout=2 (the background-ring contract)', () => {
    expect(exitCodeFor('delivered')).toBe(0)
    expect(exitCodeFor('timeout')).toBe(2)
  })
})

describe('bodyFrom', () => {
  test('prefers the -m message and falls back to stdin', async () => {
    expect(await bodyFrom('inline', () => Promise.resolve('piped'))).toBe('inline')
    expect(await bodyFrom(undefined, () => Promise.resolve('piped'))).toBe('piped')
  })
})

describe('sendTo', () => {
  test('resolves the open thread with the peer and sends into it', async () => {
    const sent: Array<{ threadId: number; body: string }> = []
    const client: SendToClient = {
      threads: () => Promise.resolve({ threads: [threadView(4, 'ci', 'open')] }),
      send: (input) => {
        sent.push(input)
        return Promise.resolve({ message: msg(9, input.body) })
      },
    }
    const out = await sendTo(client, 'volumi', 'hello there')
    expect(sent).toEqual([{ threadId: 4, body: 'hello there' }])
    expect(out.message.id).toBe(9)
  })

  test('propagates resolution errors (no open thread)', async () => {
    const client: SendToClient = {
      threads: () => Promise.resolve({ threads: [] }),
      send: () => Promise.reject(new Error('should not send')),
    }
    await expect(sendTo(client, 'volumi', 'x')).rejects.toThrow(/no open thread/)
  })
})

describe('ackAll', () => {
  test('acks through the current inbox cursor', async () => {
    const acked: number[] = []
    const client: AckAllClient = {
      inbox: () => Promise.resolve({ messages: [msg(5, 'a'), msg(6, 'b')], cursor: 6 }),
      ack: (through) => {
        acked.push(through)
        return Promise.resolve({ ackedThroughMessageId: through })
      },
    }
    expect(await ackAll(client)).toBe(6)
    expect(acked).toEqual([6])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands.test.ts`
Expected: FAIL — cannot find module `./commands.js`

- [ ] **Step 3: Write `src/cli/commands.ts`**

```ts
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

export async function sendTo(client: SendToClient, peer: string, body: string): Promise<SendOutput> {
  const { threads } = await client.threads('open')
  const threadId = resolvePeerThread(threads, peer)
  return client.send({ threadId, body })
}

export async function ackAll(client: AckAllClient): Promise<number> {
  const { cursor } = await client.inbox(0)
  const res = await client.ack(cursor)
  return res.ackedThroughMessageId
}
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run src/cli/commands.test.ts` — expected: all PASS

```powershell
git add src/cli
git commit -m "feat(cli): add tested command logic - listen loop, exit codes, stdin bodies, peer resolution"
```

### Task 14: Commander wiring

**Files:**
- Create: `src/cli/index.ts`

Pure wiring — every branch with logic was extracted and tested in Task 13; provisioning functions come from `src/core/provisioning.ts` (tested in Task 6). Verified by typecheck/lint here and the built-CLI smoke in Task 17.

- [ ] **Step 1: Write `src/cli/index.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander'
import { systemClock } from '../core/clock.js'
import { loadClientConfig, loadServerConfig } from '../core/config.js'
import { addAgent, createInvite, listAgentRecords, revokeAgent } from '../core/provisioning.js'
import { PhoneClient, registerAgent } from '../client/client.js'
import { startServer } from '../http/server.js'
import { SqliteStore } from '../store/sqlite.js'
import {
  ackAll,
  bodyFrom,
  exitCodeFor,
  formatMessage,
  listenCommand,
  sendTo,
} from './commands.js'

const out = (line: string): void => {
  process.stdout.write(line + '\n')
}

const fail = (e: unknown): never => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
}

const client = (): PhoneClient => {
  try {
    return new PhoneClient(loadClientConfig(process.env))
  } catch (e) {
    return fail(e)
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

const adminStore = (): SqliteStore =>
  new SqliteStore(process.env.AGENTPHONE_DB ?? './agentphone.db')

const program = new Command('agentphone').description(
  'phonebook, calls, and voicemail for coding agents',
)

program
  .command('register')
  .requiredOption('--name <name>')
  .requiredOption('--invite <code>')
  .option('--url <url>', 'server url (defaults to AGENTPHONE_URL)')
  .action(async (o: { name: string; invite: string; url?: string }) => {
    const url = o.url ?? process.env.AGENTPHONE_URL
    if (!url) fail(new Error('pass --url or set AGENTPHONE_URL'))
    const res = await registerAgent(url as string, { name: o.name, inviteCode: o.invite }).catch(
      fail,
    )
    out(`registered "${res.name}"`)
    out(`token (shown once - store it): ${res.token}`)
    out(`set AGENTPHONE_TOKEN=${res.token}`)
  })

program
  .command('checkin')
  .option('--status <text>')
  .action(async (o: { status?: string }) => {
    const res = await client().checkin(o.status).catch(fail)
    out(`checked in as ${res.name}${res.status ? ` (${res.status})` : ''}`)
  })

program.command('phonebook').action(async () => {
  const res = await client().phonebook().catch(fail)
  for (const a of res.agents) {
    const seen = new Date(a.lastSeenAt).toISOString()
    out(`${a.name}  listening=${a.listening}  lastSeen=${seen}${a.status ? `  "${a.status}"` : ''}`)
  }
})

program
  .command('call <agent>')
  .requiredOption('--subject <subject>')
  .option('-m, --message <body>')
  .action(async (agent: string, o: { subject: string; message?: string }) => {
    const res = await client()
      .call({ to: agent, subject: o.subject, body: o.message })
      .catch(fail)
    out(`call opened: thread #${res.thread.id} "${res.thread.subject}" with ${agent}`)
    if (res.message) out(`sent #${res.message.id}`)
  })

program
  .command('send')
  .option('--thread <id>')
  .option('--to <agent>')
  .option('-m, --message <body>')
  .action(async (o: { thread?: string; to?: string; message?: string }) => {
    const c = client()
    const body = await bodyFrom(o.message, readStdin)
    if (o.thread !== undefined) {
      const res = await c.send({ threadId: Number(o.thread), body }).catch(fail)
      out(`sent #${res.message.id} to ${res.message.recipient} (thread #${res.message.threadId})`)
    } else if (o.to !== undefined) {
      const res = await sendTo(c, o.to, body).catch(fail)
      out(`sent #${res.message.id} to ${res.message.recipient} (thread #${res.message.threadId})`)
    } else {
      fail(new Error('pass --thread <id> or --to <agent>'))
    }
  })

program
  .command('listen')
  .option('--wait <seconds>', 'total seconds to wait', '3600')
  .option('--ack', 'auto-ack delivered messages', false)
  .action(async (o: { wait: string; ack: boolean }) => {
    const result = await listenCommand(
      client(),
      { waitSeconds: Number(o.wait), autoAck: o.ack },
      out,
    ).catch(fail)
    process.exitCode = exitCodeFor(result)
  })

program.command('inbox').action(async () => {
  const res = await client().inbox().catch(fail)
  if (res.messages.length === 0) {
    out('no voicemail')
    return
  }
  for (const m of res.messages) out(formatMessage(m))
  out(`unacked - when processed, run: agentphone ack --through ${res.cursor}`)
})

program
  .command('ack')
  .option('--through <id>')
  .option('--all', 'ack everything currently in the inbox', false)
  .action(async (o: { through?: string; all: boolean }) => {
    const c = client()
    if (o.all) {
      const through = await ackAll(c).catch(fail)
      out(`acked through #${through}`)
    } else if (o.through !== undefined) {
      const res = await c.ack(Number(o.through)).catch(fail)
      out(`acked through #${res.ackedThroughMessageId}`)
    } else {
      fail(new Error('pass --through <id> or --all'))
    }
  })

program
  .command('history <threadId>')
  .option('--after <id>', 'only messages after this id', '0')
  .action(async (threadId: string, o: { after: string }) => {
    const res = await client().history(Number(threadId), Number(o.after)).catch(fail)
    for (const m of res.messages) out(formatMessage(m))
  })

program
  .command('threads')
  .option('--all', 'include ended threads', false)
  .option('--ended', 'only ended threads', false)
  .action(async (o: { all: boolean; ended: boolean }) => {
    const status = o.all ? 'all' : o.ended ? 'ended' : 'open'
    const res = await client().threads(status).catch(fail)
    for (const t of res.threads) {
      out(`#${t.id} [${t.status}] "${t.subject}" ${t.participants.join(' <-> ')}`)
    }
  })

program
  .command('hangup <threadId>')
  .option('--note <text>')
  .action(async (threadId: string, o: { note?: string }) => {
    const res = await client().hangup(Number(threadId), o.note).catch(fail)
    out(`hung up thread #${res.thread.id}`)
  })

program.command('serve').action(async () => {
  const cfg = loadServerConfig(process.env)
  const running = await startServer(cfg)
  out(`agentphone listening on ${cfg.bind}:${running.port} (db: ${cfg.dbPath})`)
})

const admin = program.command('admin').description('server-host provisioning (direct db access)')

admin.command('add <name>').action((name: string) => {
  const store = adminStore()
  try {
    const res = addAgent(store, systemClock, name)
    out(`agent "${res.name}" added`)
    out(`token (shown once - deliver securely): ${res.token}`)
  } catch (e) {
    fail(e)
  } finally {
    store.close()
  }
})

admin
  .command('invite')
  .option('--name <name>', 'pin the invite to a specific agent name')
  .option('--ttl-hours <hours>', 'invite validity window', '24')
  .action((o: { name?: string; ttlHours: string }) => {
    const store = adminStore()
    try {
      const res = createInvite(store, systemClock, {
        pinnedName: o.name,
        ttlHours: Number(o.ttlHours),
      })
      out(`invite (single-use, expires ${new Date(res.expiresAt).toISOString()}): ${res.code}`)
    } finally {
      store.close()
    }
  })

admin.command('list').action(() => {
  const store = adminStore()
  try {
    for (const a of listAgentRecords(store)) {
      out(`${a.name}  lastSeen=${new Date(a.lastSeenAt).toISOString()}`)
    }
  } finally {
    store.close()
  }
})

admin.command('revoke <name>').action((name: string) => {
  const store = adminStore()
  try {
    revokeAgent(store, name)
    out(`agent "${name}" revoked`)
  } catch (e) {
    fail(e)
  } finally {
    store.close()
  }
})

program.parseAsync(process.argv).catch(fail)
```

- [ ] **Step 2: Typecheck, lint, full suite, commit**

```powershell
npm run typecheck
npm run lint
npm test
git add src/cli/index.ts
git commit -m "feat(cli): wire commander surface over tested command logic and core provisioning"
```

---

## Phase 5 — Integration story, CI, docs

### Task 15: End-to-end story test (incl. restart persistence + 401)

**Files:**
- Test: `test/story.test.ts`

- [ ] **Step 1: Write the test** — `test/story.test.ts`

```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PhoneClient, registerAgent } from '../src/client/client.js'
import { systemClock } from '../src/core/clock.js'
import type { ServerConfig } from '../src/core/config.js'
import { createInvite } from '../src/core/provisioning.js'
import { startServer } from '../src/http/server.js'
import { SqliteStore } from '../src/store/sqlite.js'

describe('the whole story', () => {
  test('register, call, listen-wake, voicemail, ack, hangup, restart persistence, 401', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentphone-story-'))
    const cfg: ServerConfig = {
      port: 0,
      bind: '127.0.0.1',
      dbPath: join(dir, 'story.db'),
      eventsPath: join(dir, 'events.jsonl'),
      threadTtlHours: 24,
    }

    // operator mints invites on the server host (direct db access)
    const provisioning = new SqliteStore(cfg.dbPath)
    const ghaInvite = createInvite(provisioning, systemClock, { pinnedName: 'gha-docker-runner' })
    const volInvite = createInvite(provisioning, systemClock, {})
    provisioning.close()

    let running = await startServer(cfg)
    const url = `http://127.0.0.1:${running.port}`

    // both agents self-register with their invites
    const gha = await registerAgent(url, {
      name: 'gha-docker-runner',
      inviteCode: ghaInvite.code,
    })
    const vol = await registerAgent(url, { name: 'volumi', inviteCode: volInvite.code })
    const ghaClient = new PhoneClient({ url, token: gha.token })
    const volClient = new PhoneClient({ url, token: vol.token })

    // a wrong token is rejected on an authenticated route
    const badToken = await fetch(`${url}/api/agents`, {
      headers: { authorization: 'Bearer ap_wrong' },
    })
    expect(badToken.status).toBe(401)

    // volumi parks a listen (the background ring); gha calls - the listen wakes
    const parked = volClient.inbox(10_000)
    await new Promise((r) => setTimeout(r, 50))
    const { thread } = await ghaClient.call({
      to: 'volumi',
      subject: 'runner core v2',
      body: 'new build is up, try it',
    })
    const woken = await parked
    expect(woken.messages.map((m) => m.body)).toEqual(['new build is up, try it'])
    await volClient.ack(woken.cursor)

    // volumi replies while gha is NOT listening -> lands as voicemail
    await volClient.send({ threadId: thread.id, body: 'works on macos, one nit' })

    // restart the server: unacked voicemail must survive
    await running.close()
    running = await startServer(cfg)
    const url2 = `http://127.0.0.1:${running.port}`
    const ghaClient2 = new PhoneClient({ url: url2, token: gha.token })
    const volClient2 = new PhoneClient({ url: url2, token: vol.token })

    const voicemail = await ghaClient2.inbox()
    expect(voicemail.messages.map((m) => m.body)).toEqual(['works on macos, one nit'])
    await ghaClient2.ack(voicemail.cursor)

    // wrap up
    const ended = await ghaClient2.hangup(thread.id, 'shipping it, thanks')
    expect(ended.thread.status).toBe('ended')
    const volInbox = await volClient2.inbox()
    expect(volInbox.messages.map((m) => m.kind)).toEqual(['system'])

    // canonical events were written as jsonl
    const lines = readFileSync(cfg.eventsPath, 'utf8').trim().split('\n')
    expect(lines.length).toBeGreaterThan(5)
    const parsed = lines.map((l) => JSON.parse(l) as { op: string; outcome: string })
    expect(parsed.every((e) => typeof e.op === 'string' && typeof e.outcome === 'string')).toBe(true)

    await running.close()
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/story.test.ts`
Expected: PASS. This is the acceptance-criteria test — if it fails, the bug is real; debug with superpowers:systematic-debugging, do not weaken the test.

- [ ] **Step 3: Commit**

```powershell
git add test/story.test.ts
git commit -m "test(integration): pin the end-to-end story including restart persistence and 401"
```

### Task 16: CI matrix (Windows + macOS — acceptance criterion 6)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
```

(macOS runners are arm64 — this also proves the better-sqlite3 prebuild story for the MacBook. CI runs verify on push/PR; record the first green matrix in `impl.md`.)

- [ ] **Step 2: Commit**

```powershell
git add .github
git commit -m "ci: add windows+macos node 20/22 matrix"
```

### Task 17: README, impl notes, final verification

**Files:**
- Create: `README.md`
- Modify: `docs/increment-1-agentphone-core/impl.md` (fill Verification evidence; append any execution deviations)

- [ ] **Step 1: Write `README.md`**

````markdown
# agentphone

Phonebook, calls, and voicemail for coding agents on different machines. One server,
three surfaces: JSON HTTP API, MCP (streamable HTTP), and a CLI built for backgrounding.

## Server (once, on the host machine)

```powershell
npm install
npm run build
$env:AGENTPHONE_BIND = "0.0.0.0"   # expose on the mesh
node dist/agentphone.js serve
```

Config (env, all optional): `AGENTPHONE_PORT` (4747), `AGENTPHONE_BIND` (127.0.0.1),
`AGENTPHONE_DB` (./agentphone.db), `AGENTPHONE_EVENTS` (./agentphone.events.jsonl),
`AGENTPHONE_THREAD_TTL_HOURS` (24).

## Provisioning (operator, on the server host)

```powershell
node dist/agentphone.js admin invite --name volumi   # single-use code, 24h
node dist/agentphone.js admin list
node dist/agentphone.js admin revoke volumi
```

## Agent setup (each machine)

```bash
export AGENTPHONE_URL=http://100.110.150.142:4747
agentphone register --name volumi --invite ap-invite-XXXX   # prints token once
export AGENTPHONE_TOKEN=ap_...
```

MCP (optional, same auth):

```bash
claude mcp add agentphone --transport http $AGENTPHONE_URL/mcp \
  --header "Authorization: Bearer $AGENTPHONE_TOKEN"
```

## Using the phone

```bash
agentphone phonebook
agentphone call volumi --subject "runner core v2" -m "new build is up"
agentphone listen --wait 3600        # exits when a message arrives - run as a background task
agentphone inbox                     # peek voicemail (never consumes)
agentphone ack --through 7           # at-least-once: messages redeliver until acked
agentphone send --to volumi -m "..." # or pipe: git diff | agentphone send --to volumi
agentphone hangup 3 --note "done"
```

**The ring:** background `agentphone listen` from your agent harness; the process exits
when a message arrives (exit 0) or the window closes empty (exit 2), which re-invokes
the agent with the messages as output.
````

- [ ] **Step 2: Final verification (all must pass)**

```powershell
npm run build
npm run typecheck
npm run lint
npm test
```

Expected: build emits `dist/agentphone.js`; typecheck/lint clean; full suite green.
Record the outcome in `impl.md` under Verification evidence.

- [ ] **Step 3: Smoke the built CLI end-to-end on this machine (incl. the exit-code contract)**

```powershell
$env:AGENTPHONE_DB = "$env:TEMP\agentphone-smoke.db"
node dist/agentphone.js admin invite
# in a second shell: $env:AGENTPHONE_DB="$env:TEMP\agentphone-smoke.db"; node dist/agentphone.js serve
node dist/agentphone.js register --name smoke-test --invite <code> --url http://127.0.0.1:4747
$env:AGENTPHONE_URL = "http://127.0.0.1:4747"
$env:AGENTPHONE_TOKEN = "<token printed above>"
node dist/agentphone.js listen --wait 1
$LASTEXITCODE   # expected: 2 (timeout, nothing to deliver)
```

Expected: invite prints; registration prints a token; `listen --wait 1` prints "no messages"
and exits with code 2. Stop the serve shell; delete `$env:TEMP\agentphone-smoke.db*`.

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/increment-1-agentphone-core/impl.md
git commit -m "docs: add quickstart readme and record increment-1 verification evidence"
```

**Final holistic review (per project CLAUDE.md):** one comprehensive review pass over the whole increment against design.md, plan.md, overview.md, and the conventions — then PR via `gh pr create --fill`, fix findings, re-verify, merge with `gh pr merge --merge --delete-branch`.

---

## Plan self-review (completed by plan author, rev 2)

1. **Spec coverage:** every design verb, surface, error code (incl. 413), TTL rule, delivery guarantee (incl. the 500-message batch cap), config key, observability requirement (incl. boundary events), and acceptance criterion maps to a task (verbs → Tasks 6-8; HTTP+auth+boundary events → Task 10; MCP incl. send/listen tools → Task 11; CLI ring/exit codes/stdin/--to/--all → Tasks 13-14+17; invites/provisioning → Task 6; restart persistence + jsonl + 401 → Task 15; both-OS → Task 16 CI matrix + Task 17 smoke).
2. **Placeholder scan:** no TBDs; every code step carries the full code.
3. **Type consistency:** port signatures (`listUnacked(recipient, afterId, limit)`), schema names, `CallCtx`/`Surface`, `buildApp` deps (`service, emitter, clock, mcpHandler?`), and `.js` ESM import suffixes are consistent across all tasks.
4. **Review-gate traceability:** every HIGH/MEDIUM finding from the plan-review gate maps to a concrete change in this revision; see `impl.md` → Review findings & resolutions.



