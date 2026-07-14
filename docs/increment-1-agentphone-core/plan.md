# agentphone Core Implementation Plan (Increment 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agentphone server — phonebook, calls (threads), messages, long-poll listen, voicemail — with one contract-first core and three thin surfaces (HTTP JSON API, MCP streamable-HTTP, typed CLI), per `docs/increment-1-agentphone-core/design.md`.

**Architecture:** zod contracts + `PhoneService` core with injected ports (`Store`, `Emitter`, `Clock`); better-sqlite3 store; express HTTP adapter with bearer-token auth middleware; MCP adapter mounted on the same express app; typed fetch client consumed by a commander CLI. Dependencies flow inward: `cli → client → HTTP → core ← store`, `mcp → core`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, Node 20+), express 4, zod 3, @modelcontextprotocol/sdk, better-sqlite3, commander, vitest, tsup, eslint (typescript-eslint strict) + prettier.

**Conventions (from project CLAUDE.md — apply in every task):**
- TDD: write the failing test first, watch it fail, implement, watch it pass, commit.
- Tests assert OUR contracts, not zod/express/sqlite behavior. Minimum-optimal set.
- No `as any`. Fail-fast required config. No ad-hoc logging on core paths — canonical wide events only.
- Commit format: `type(component): message` (e.g. `feat(core): add delivery semantics`).
- Do not use `cd` when already in `O:\_web\omnith\agentphone`. No git pager flags.

---

## File structure (locked in)

```
package.json / tsconfig.json / eslint.config.js / .prettierrc.json / vitest.config.ts / tsup.config.ts / .gitignore
src/core/errors.ts        PhoneError, codes, http status map
src/core/ports.ts         Store (5 segregated interfaces), Emitter, Clock, record types
src/core/clock.ts         systemClock
src/core/tokens.ts        newToken / newInviteCode / hashSecret
src/core/contracts.ts     zod schemas + inferred types for all verbs
src/core/waiters.ts       Waiters (long-poll park/notify)
src/core/service.ts       PhoneService (all 11 verbs + authenticate + instrumentation)
src/core/testkit.ts       FakeClock, makeService, provision helpers (test-only utilities)
src/core/config.ts        loadServerConfig / loadClientConfig
src/store/sqlite.ts       SqliteStore implements Store
src/obs/emitters.ts       JsonlEmitter, MemoryEmitter
src/http/app.ts           buildApp (routes, auth middleware, error handler, /mcp mount)
src/http/server.ts        startServer(config)
src/mcp/tools.ts          buildMcpServer(service, agent)
src/client/client.ts      PhoneClient + ClientError + registerAgent
src/cli/commands.ts       listenCommand, sendToCommand, resolvePeerThread, formatters
src/cli/admin.ts          createInvite, addAgent, revokeAgent, listAgentRecords
src/cli/index.ts          #!/usr/bin/env node — commander wiring (thin; no logic)
test/story.test.ts        end-to-end story incl. restart persistence
test/mcp.test.ts          MCP SDK client round-trip
```

Unit tests are colocated: `src/core/waiters.test.ts`, `src/core/service.identity.test.ts`, `src/core/service.calls.test.ts`, `src/core/service.delivery.test.ts`, `src/store/sqlite.test.ts`, `src/core/config.test.ts`, `src/http/app.test.ts`, `src/client/client.test.ts`, `src/cli/commands.test.ts`, `src/cli/admin.test.ts`.

---

## Phase 0 — Scaffold

### Task 1: Repo scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `vitest.config.ts`, `tsup.config.ts`, `.gitignore`, `src/smoke.test.ts`

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
    "lint": "eslint . && prettier --check \"**/*.{ts,js,json,md}\"",
    "format": "prettier --write \"**/*.{ts,js,json,md}\""
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
    "@types/node": "^24.0.0",
    "eslint": "^9.30.0",
    "prettier": "^3.6.0",
    "tsup": "^8.5.0",
    "typescript": "^5.8.0",
    "typescript-eslint": "^8.35.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src", "test", "vitest.config.ts", "tsup.config.ts"]
}
```

- [ ] **Step 4: Write `eslint.config.js`**

```js
import tseslint from 'typescript-eslint'

export default tseslint.config({ ignores: ['dist/**', 'node_modules/**'] }, ...tseslint.configs.strict, {
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
  },
})
```

- [ ] **Step 5: Write `.prettierrc.json`**

```json
{ "semi": false, "singleQuote": true, "printWidth": 100 }
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

Expected: install succeeds (better-sqlite3 uses a prebuilt binary on Windows/Node 20+); 1 test passes; typecheck and lint clean. If prettier flags files, run `npm run format` once and re-check.

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

- [ ] **Step 4: Write `src/core/errors.ts`** (no test — a data map; exercised by service/http tests)

```ts
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'NAME_TAKEN'
  | 'INVITE_INVALID'
  | 'VALIDATION_ERROR'
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
  listUnacked(recipient: string, afterId: number, threadId?: number): MessageRecord[]
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

No dedicated test file — schema behavior is zod's (a dependency); OUR use of the schemas is exercised by service/http/client tests in later tasks.

- [ ] **Step 1: Write `src/core/contracts.ts`**

```ts
import { z } from 'zod'

export const AgentNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,30}$/, 'lowercase slug, 2-31 chars, a-z 0-9 hyphen')
export const MessageBodySchema = z.string().min(1).max(64 * 1024)
export const WaitMsSchema = z.number().int().min(0).max(60_000)

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

export const ListenInputSchema = z.object({
  waitMs: WaitMsSchema.default(0),
  threadId: z.number().int().optional(),
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
  threadId: z.coerce.number().int().optional(),
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

Only the nontrivial queries get direct tests (`listUnacked` filtering, `listThreadsFor` on both columns, cursor upsert, `maxMessageId`); plain CRUD is exercised through service tests.

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
  test('listUnacked filters by recipient, afterId, and optional threadId, in id order', () => {
    const s = new SqliteStore(':memory:')
    const t1 = s.insertThread(thread('a-1', 'b-1', 'one'))
    const t2 = s.insertThread(thread('a-1', 'b-1', 'two'))
    const m1 = s.insertMessage(msg(t1, 'a-1', 'b-1', 'first'))
    const m2 = s.insertMessage(msg(t2, 'a-1', 'b-1', 'second'))
    const m3 = s.insertMessage(msg(t1, 'b-1', 'a-1', 'reply'))

    expect(s.listUnacked('b-1', 0).map((m) => m.id)).toEqual([m1, m2])
    expect(s.listUnacked('b-1', m1).map((m) => m.id)).toEqual([m2])
    expect(s.listUnacked('b-1', 0, t1).map((m) => m.id)).toEqual([m1])
    expect(s.listUnacked('a-1', 0).map((m) => m.id)).toEqual([m3])
    expect(s.listUnacked('a-1', m3)).toEqual([])
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
  listUnacked(recipient: string, afterId: number, threadId?: number): MessageRecord[] {
    if (threadId === undefined) {
      return this.db
        .prepare('SELECT * FROM messages WHERE recipient = ? AND id > ? ORDER BY id LIMIT 500')
        .all(recipient, afterId) as MessageRecord[]
    }
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE recipient = ? AND id > ? AND threadId = ? ORDER BY id LIMIT 500',
      )
      .all(recipient, afterId, threadId) as MessageRecord[]
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

### Task 6: Emitters + PhoneService — identity & presence

**Files:**
- Create: `src/obs/emitters.ts`, `src/core/service.ts`, `src/core/testkit.ts`
- Test: `src/core/service.identity.test.ts`

- [ ] **Step 1: Write `src/obs/emitters.ts`** (MemoryEmitter is needed by every service test; JsonlEmitter's file behavior is tested in Task 8)

```ts
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Emitter, PhoneEvent } from '../core/ports.js'

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

- [ ] **Step 2: Write `src/core/testkit.ts`**

```ts
// test-only helpers shared by unit tests (not shipped: only imported from *.test.ts)
import { MemoryEmitter } from '../obs/emitters.js'
import { SqliteStore } from '../store/sqlite.js'
import type { Clock } from './ports.js'
import { PhoneService } from './service.js'
import { hashSecret, newInviteCode, newToken } from './tokens.js'

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
  const token = newToken()
  h.store.insertAgent({
    name,
    tokenHash: hashSecret(token),
    status: null,
    lastSeenAt: h.clock.now(),
    createdAt: h.clock.now(),
  })
  return token
}

// create a live invite directly (admin path), returning the code
export function invite(h: Harness, opts: { pinnedName?: string; ttlMs?: number } = {}): string {
  const code = newInviteCode()
  h.store.insertInvite({
    codeHash: hashSecret(code),
    pinnedName: opts.pinnedName ?? null,
    expiresAt: h.clock.now() + (opts.ttlMs ?? 24 * 3600_000),
    usedBy: null,
    usedAt: null,
    createdAt: h.clock.now(),
  })
  return code
}
```

- [ ] **Step 3: Write the failing test** — `src/core/service.identity.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { PhoneError } from './errors.js'
import { invite, makeService, provision } from './testkit.js'

describe('register (invite lifecycle)', () => {
  test('valid invite mints an ap_ token and the agent appears in the phonebook', async () => {
    const h = makeService()
    const code = invite(h)
    const out = await h.service.register({ name: 'volumi', inviteCode: code }, 'http')
    expect(out.token).toMatch(/^ap_/)
    const viewer = provision(h, 'viewer')
    void viewer
    const book = await h.service.phonebook({ agent: 'viewer', surface: 'http' })
    expect(book.agents.map((a) => a.name)).toContain('volumi')
  })

  test('an invite is single-use', async () => {
    const h = makeService()
    const code = invite(h)
    await h.service.register({ name: 'volumi', inviteCode: code }, 'http')
    await expect(h.service.register({ name: 'other', inviteCode: code }, 'http')).rejects.toThrow(
      PhoneError,
    )
  })

  test('an expired invite is rejected', async () => {
    const h = makeService()
    const code = invite(h, { ttlMs: 1000 })
    h.clock.advance(1001)
    await expect(h.service.register({ name: 'volumi', inviteCode: code }, 'http')).rejects.toMatchObject(
      { code: 'INVITE_INVALID' },
    )
  })

  test('a pinned invite only registers its pinned name', async () => {
    const h = makeService()
    const code = invite(h, { pinnedName: 'lab7' })
    await expect(h.service.register({ name: 'volumi', inviteCode: code }, 'http')).rejects.toMatchObject(
      { code: 'INVITE_INVALID' },
    )
    const again = invite(h, { pinnedName: 'lab7' })
    const out = await h.service.register({ name: 'lab7', inviteCode: again }, 'http')
    expect(out.name).toBe('lab7')
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
    const agent = h.service.authenticate(token)
    expect(agent.name).toBe('volumi')
    expect(h.store.getAgent('volumi')?.lastSeenAt).toBe(h.clock.now())
  })

  test('missing or bad token throws UNAUTHORIZED and emits one auth error event', () => {
    const h = makeService()
    expect(() => h.service.authenticate(undefined)).toThrow(PhoneError)
    expect(() => h.service.authenticate('ap_wrong')).toThrow(PhoneError)
    const authEvents = h.emitter.events.filter((e) => e.op === 'auth')
    expect(authEvents).toHaveLength(2)
    expect(authEvents.every((e) => e.outcome === 'error')).toBe(true)
  })
})

describe('checkin + phonebook presence', () => {
  test('checkin sets the status text shown in the phonebook', async () => {
    const h = makeService()
    provision(h, 'volumi')
    provision(h, 'gha-docker-runner')
    await h.service.checkin(
      { agent: 'volumi', surface: 'http' },
      { status: 'iterating on CI retries' },
    )
    const book = await h.service.phonebook({ agent: 'gha-docker-runner', surface: 'http' })
    const volumi = book.agents.find((a) => a.name === 'volumi')
    expect(volumi?.status).toBe('iterating on CI retries')
  })

  test('phonebook reports listening=true while a listen is parked', async () => {
    const h = makeService()
    provision(h, 'volumi')
    provision(h, 'gha-docker-runner')
    const parked = h.service.listen({ agent: 'volumi', surface: 'http' }, { waitMs: 1500 })
    await new Promise((r) => setTimeout(r, 50))
    const book = await h.service.phonebook({ agent: 'gha-docker-runner', surface: 'http' })
    expect(book.agents.find((a) => a.name === 'volumi')?.listening).toBe(true)
    await h.service.send(
      { agent: 'gha-docker-runner', surface: 'http' },
      { threadId: (await h.service.call({ agent: 'gha-docker-runner', surface: 'http' }, { to: 'volumi', subject: 'wake' })).thread.id, body: 'wake up' },
    )
    await parked
  })
})
```

Note: the last test also exercises `call`/`send`/`listen`, implemented in this task and Task 7 — the whole `PhoneService` class lands here; Task 7 and Task 8 land its remaining tests.

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/core/service.identity.test.ts`
Expected: FAIL — cannot find module `./service.js`

- [ ] **Step 5: Write `src/core/service.ts`** (complete class — later tasks only add tests)

```ts
import type {
  AckInput,
  AckOutput,
  AgentView,
  CallInput,
  CallOutput,
  CheckinInput,
  CheckinOutput,
  HangupInput,
  HangupOutput,
  HistoryInput,
  HistoryOutput,
  ListenInput,
  ListenOutput,
  MessageView,
  PhonebookOutput,
  RegisterInput,
  RegisterOutput,
  SendInput,
  SendOutput,
  ThreadsInput,
  ThreadsOutput,
  ThreadView,
} from './contracts.js'
import { PhoneError } from './errors.js'
import type {
  AgentRecord,
  Clock,
  Emitter,
  MessageRecord,
  Store,
  Surface,
  ThreadRecord,
} from './ports.js'
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
  authenticate(token: string | undefined): AgentRecord {
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
      surface: 'http',
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

  // --- calls ---
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
        message = this.toMessageView({ id, threadId, sender: ctx.agent, recipient: input.to, body: input.body, kind: 'message', createdAt: now })
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
      // reopen-on-send: sending always makes the thread open again
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
      const ended: ThreadRecord = {
        ...thread,
        status: 'ended',
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
      const filtered =
        input.status === 'all' ? all : all.filter((t) => t.status === input.status)
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

  // --- delivery ---
  listen(ctx: CallCtx, input: ListenInput): Promise<ListenOutput> {
    return this.op('listen', ctx.surface, ctx.agent, async (ev) => {
      const start = this.clock.now()
      const deadline = start + input.waitMs
      for (;;) {
        const cursor = this.store.getCursor(ctx.agent)
        const records = this.store.listUnacked(ctx.agent, cursor, input.threadId)
        const now = this.clock.now()
        if (records.length > 0 || now >= deadline) {
          ev.deliveredCount = records.length
          ev.waitedMs = now - start
          const last = records[records.length - 1]
          return {
            messages: records.map((m) => this.toMessageView(m)),
            cursor: last ? last.id : cursor,
          }
        }
        await this.waiters.wait(ctx.agent, deadline - now)
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

  // --- helpers ---
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
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/core/service.identity.test.ts`
Expected: all PASS

- [ ] **Step 7: Run full suite + typecheck + lint, commit**

```powershell
npm test
npm run typecheck
npm run lint
git add src/core src/obs
git commit -m "feat(core): add PhoneService with identity, presence, and instrumentation"
```

### Task 7: PhoneService — calls behavior tests (TTL, reopen, hangup)

**Files:**
- Test: `src/core/service.calls.test.ts` (implementation already landed in Task 6 — these tests pin the contracts; if any fail, fix `service.ts` until they pass)

- [ ] **Step 1: Write the test file** — `src/core/service.calls.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { makeService, provision } from './testkit.js'

const HOUR = 3600_000

function twoAgents() {
  const h = makeService()
  provision(h, 'gha-docker-runner')
  provision(h, 'volumi')
  return h
}
const gha = { agent: 'gha-docker-runner', surface: 'http' as const }
const vol = { agent: 'volumi', surface: 'http' as const }

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
})

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

describe('thread openness TTL (lazy)', () => {
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
      h.service.history({ agent: 'intruder', surface: 'http' }, { threadId: thread.id, afterId: 0, limit: 100 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/core/service.calls.test.ts`
Expected: all PASS (implementation landed in Task 6). If any FAIL, fix `src/core/service.ts` — the tests are the contract.

- [ ] **Step 3: Commit**

```powershell
git add src/core/service.calls.test.ts src/core/service.ts
git commit -m "test(core): pin call semantics - reopen, hangup notes, lazy TTL, history"
```

### Task 8: PhoneService — delivery tests + JsonlEmitter

**Files:**
- Test: `src/core/service.delivery.test.ts`

- [ ] **Step 1: Write the test file** — `src/core/service.delivery.test.ts`

```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { JsonlEmitter } from '../obs/emitters.js'
import type { PhoneEvent } from './ports.js'
import { makeService, provision } from './testkit.js'

const gha = { agent: 'gha-docker-runner', surface: 'http' as const }
const vol = { agent: 'volumi', surface: 'http' as const }

function twoAgents() {
  const h = makeService()
  provision(h, 'gha-docker-runner')
  provision(h, 'volumi')
  return h
}

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
    // lower ack does not regress
    expect((await h.service.ack(vol, { throughMessageId: 0 })).ackedThroughMessageId).toBe(cursor)
    // future ack caps at max existing id
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

  test('threadId filter ignores traffic on other threads', async () => {
    const h = twoAgents()
    const a = await h.service.call(gha, { to: 'volumi', subject: 'watch-this' })
    const b = await h.service.call(gha, { to: 'volumi', subject: 'noise' })
    const parked = h.service.listen(vol, { waitMs: 300, threadId: a.thread.id })
    await new Promise((r) => setTimeout(r, 30))
    await h.service.send(gha, { threadId: b.thread.id, body: 'noise message' })
    const out = await parked
    expect(out.messages).toEqual([]) // timed out; the noise thread did not satisfy the filter
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

  test('JsonlEmitter writes one JSON line per event', () => {
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

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/core/service.delivery.test.ts`
Expected: all PASS. If any FAIL, fix `src/core/service.ts` / `src/obs/emitters.ts` — the tests are the contract.

- [ ] **Step 3: Run the full suite, commit**

```powershell
npm test
git add src/core/service.delivery.test.ts
git commit -m "test(core): pin delivery semantics - at-least-once, long-poll wake, canonical events"
```

**Phase 1 checkpoint (per project CLAUDE.md):** dispatch parallel spec-conformance + code-quality reviews of `src/core` + `src/store` before starting Phase 2. Fix HIGH/MEDIUM findings before continuing.

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
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got "${raw}"`)
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

- [ ] **Step 1: Write the failing test** — `src/http/app.test.ts`

```ts
import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { invite, makeService, provision, type Harness } from '../core/testkit.js'
import { buildApp } from './app.js'

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function boot(h: Harness): Promise<string> {
  const app = buildApp({ service: h.service })
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

  test('validation failures return the single error shape with 422', async () => {
    const h = makeService()
    const token = provision(h, 'volumi')
    const base = await boot(h)
    const res = await fetch(`${base}/api/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: 'volumi' }), // missing subject
    })
    expect(res.status).toBe(422)
    expect(await asJson(res)).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
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
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express'
import { ZodError } from 'zod'
import {
  AckInputSchema,
  CallInputSchema,
  CheckinInputSchema,
  HangupInputSchema,
  HistoryQuerySchema,
  ListenQuerySchema,
  RegisterInputSchema,
  SendInputSchema,
  ThreadsQuerySchema,
} from '../core/contracts.js'
import { httpStatus, PhoneError } from '../core/errors.js'
import type { PhoneService } from '../core/service.js'
import { handleMcpRequest } from '../mcp/tools.js'

export interface AppDeps {
  service: PhoneService
}

// express 4 does not catch async rejections; wrap every async handler
const asyncH =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next)
  }

const agentOf = (res: Response): string => res.locals.agent as string

export function buildApp(deps: AppDeps): express.Express {
  const { service } = deps
  const app = express()
  app.use(express.json({ limit: '256kb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.post(
    '/api/register',
    asyncH(async (req, res) => {
      const input = RegisterInputSchema.parse(req.body)
      res.status(201).json(await service.register(input, 'http'))
    }),
  )

  const auth: RequestHandler = (req, res, next) => {
    const header = req.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    res.locals.agent = service.authenticate(token).name
    next()
  }

  // mcp mount (stateless streamable http) — same auth boundary
  app.post(
    '/mcp',
    auth,
    asyncH(async (req, res) => {
      await handleMcpRequest(service, agentOf(res), req, res)
    }),
  )

  const api = express.Router()
  api.use(auth)

  api.get(
    '/agents',
    asyncH(async (_req, res) => {
      res.json(await service.phonebook({ agent: agentOf(res), surface: 'http' }))
    }),
  )
  api.patch(
    '/agents/me',
    asyncH(async (req, res) => {
      const input = CheckinInputSchema.parse(req.body)
      res.json(await service.checkin({ agent: agentOf(res), surface: 'http' }, input))
    }),
  )
  api.post(
    '/calls',
    asyncH(async (req, res) => {
      const input = CallInputSchema.parse(req.body)
      res.status(201).json(await service.call({ agent: agentOf(res), surface: 'http' }, input))
    }),
  )
  api.get(
    '/calls',
    asyncH(async (req, res) => {
      const input = ThreadsQuerySchema.parse(req.query)
      res.json(await service.threads({ agent: agentOf(res), surface: 'http' }, input))
    }),
  )
  api.post(
    '/calls/:id/messages',
    asyncH(async (req, res) => {
      const body = SendInputSchema.omit({ threadId: true }).parse(req.body)
      const threadId = Number(req.params.id)
      res
        .status(201)
        .json(await service.send({ agent: agentOf(res), surface: 'http' }, { threadId, ...body }))
    }),
  )
  api.get(
    '/calls/:id/messages',
    asyncH(async (req, res) => {
      const q = HistoryQuerySchema.parse(req.query)
      const threadId = Number(req.params.id)
      res.json(
        await service.history({ agent: agentOf(res), surface: 'http' }, { threadId, ...q }),
      )
    }),
  )
  api.post(
    '/calls/:id/hangup',
    asyncH(async (req, res) => {
      const body = HangupInputSchema.omit({ threadId: true }).parse(req.body)
      const threadId = Number(req.params.id)
      res.json(
        await service.hangup({ agent: agentOf(res), surface: 'http' }, { threadId, ...body }),
      )
    }),
  )
  api.get(
    '/inbox',
    asyncH(async (req, res) => {
      const q = ListenQuerySchema.parse(req.query)
      res.json(await service.listen({ agent: agentOf(res), surface: 'http' }, q))
    }),
  )
  api.put(
    '/cursor',
    asyncH(async (req, res) => {
      const input = AckInputSchema.parse(req.body)
      res.json(await service.ack({ agent: agentOf(res), surface: 'http' }, input))
    }),
  )

  app.use('/api', api)

  // single error shape for every failure mode
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res
        .status(422)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'invalid input', details: err.flatten() } })
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

Note: `handleMcpRequest` does not exist yet — create a stub now so this task compiles, Task 11 fills it in. Write `src/mcp/tools.ts`:

```ts
import type { Request, Response } from 'express'
import type { PhoneService } from '../core/service.js'

// implemented in the MCP task; stub keeps the http adapter compiling
export async function handleMcpRequest(
  _service: PhoneService,
  _agent: string,
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(501).json({ error: { code: 'INTERNAL', message: 'mcp not wired yet' } })
}
```

- [ ] **Step 4: Write `src/http/server.ts`**

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
  const service = new PhoneService(
    store,
    new JsonlEmitter(cfg.eventsPath),
    systemClock,
    cfg.threadTtlHours * 3600_000,
  )
  const app = buildApp({ service })
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
git add src/http src/mcp
git commit -m "feat(http): add express surface with bearer auth, error mapping, and long-poll inbox"
```

---

## Phase 3 — MCP surface

### Task 11: MCP tools + streamable HTTP mount

**Files:**
- Modify: `src/mcp/tools.ts` (replace the stub)
- Test: `test/mcp.test.ts`

- [ ] **Step 1: Write the failing test** — `test/mcp.test.ts`

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { makeService, provision } from '../src/core/testkit.js'
import { buildApp } from '../src/http/app.js'

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function boot() {
  const h = makeService()
  const ghaToken = provision(h, 'gha-docker-runner')
  const volToken = provision(h, 'volumi')
  const app = buildApp({ service: h.service })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server?.address()
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port')
  return { h, ghaToken, volToken, url: `http://127.0.0.1:${addr.port}/mcp` }
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
  test('lists the ten verbs as tools', async () => {
    const { url, ghaToken } = await boot()
    const client = await connect(url, ghaToken)
    const tools = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(tools).toEqual(
      ['ack', 'call', 'checkin', 'hangup', 'history', 'inbox', 'listen', 'phonebook', 'send', 'threads'].sort(),
    )
    await client.close()
  })

  test('phonebook, call, listen round-trip across two mcp clients', async () => {
    const { url, ghaToken, volToken } = await boot()
    const gha = await connect(url, ghaToken)
    const vol = await connect(url, volToken)

    const book = await gha.callTool({ name: 'phonebook', arguments: {} })
    expect(textOf(book)).toContain('volumi')

    await gha.callTool({
      name: 'call',
      arguments: { to: 'volumi', subject: 'mcp says hi', body: 'over mcp' },
    })
    const inbox = await vol.callTool({ name: 'inbox', arguments: {} })
    expect(textOf(inbox)).toContain('over mcp')
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcp.test.ts`
Expected: FAIL — the stub returns 501, so `connect` rejects.

- [ ] **Step 3: Replace `src/mcp/tools.ts` with the real adapter**

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
    { description: 'List registered agents with presence (lastSeenAt, listening).', inputSchema: {} },
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
        'Long-poll for unacked messages; returns immediately if any exist. Max waitMs 60000. For a background "ring" while you work, use the agentphone CLI: `agentphone listen --wait 3600` as a background task.',
      inputSchema: {
        waitMs: z.number().int().min(0).max(60_000).default(25_000),
        threadId: z.number().int().optional(),
      },
    },
    wrap((a: { waitMs: number; threadId?: number }) => service.listen(ctx, a)),
  )
  server.registerTool(
    'inbox',
    { description: 'Peek unacked messages (voicemail) without waiting or acking.', inputSchema: {} },
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mcp.test.ts`
Expected: all PASS. If `registerTool`'s option key differs in the installed SDK version (some versions use `inputSchema` as a zod raw shape — as written — while very old ones used `paramsSchema`), check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` and match it.

- [ ] **Step 5: Full suite + typecheck + lint, commit**

```powershell
npm test
npm run typecheck
npm run lint
git add src/mcp test/mcp.test.ts
git commit -m "feat(mcp): expose the ten verbs as stateless streamable-http tools"
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
import { invite, makeService, type Harness } from '../core/testkit.js'
import { buildApp } from '../http/app.js'
import { ClientError, PhoneClient, registerAgent } from './client.js'

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function boot(h: Harness): Promise<string> {
  const app = buildApp({ service: h.service })
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
  inbox(waitMs = 0, threadId?: number): Promise<ListenOutput> {
    const q = new URLSearchParams({ waitMs: String(waitMs) })
    if (threadId !== undefined) q.set('threadId', String(threadId))
    return this.req('GET', `/api/inbox?${q.toString()}`, ListenOutputSchema)
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

### Task 13: CLI command logic (listen loop, --to resolution, formatting)

**Files:**
- Create: `src/cli/commands.ts`
- Test: `src/cli/commands.test.ts`

- [ ] **Step 1: Write the failing test** — `src/cli/commands.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import type { ListenOutput, MessageView, ThreadView } from '../core/contracts.js'
import { listenCommand, resolvePeerThread, type ListenClient } from './commands.js'

const msg = (id: number, body: string): MessageView => ({
  id,
  threadId: 1,
  sender: 'gha-docker-runner',
  recipient: 'volumi',
  body,
  kind: 'message',
  createdAt: 1000,
})

const threadView = (id: number, subject: string, status: 'open' | 'ended'): ThreadView => ({
  id,
  subject,
  participants: ['gha-docker-runner', 'volumi'],
  openedBy: 'gha-docker-runner',
  status,
  endedBy: null,
  endNote: null,
  openedAt: 1000,
  lastActivityAt: 1000,
})

describe('resolvePeerThread', () => {
  test('resolves the single open thread with the peer', () => {
    const threads = [threadView(1, 'ci', 'open'), threadView(2, 'old', 'ended')]
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands.test.ts`
Expected: FAIL — cannot find module `./commands.js`

- [ ] **Step 3: Write `src/cli/commands.ts`**

```ts
import type { AckOutput, ListenOutput, MessageView, ThreadView } from '../core/contracts.js'
import { ClientError } from '../client/client.js'

export interface ListenClient {
  inbox(waitMs?: number, threadId?: number): Promise<ListenOutput>
  ack(throughMessageId: number): Promise<AckOutput>
}

export interface ListenOptions {
  waitSeconds: number
  autoAck: boolean
  threadId?: number
}

const POLL_CAP_MS = 60_000

export function formatMessage(m: MessageView): string {
  const tag = m.kind === 'system' ? ' [system]' : ''
  return `#${m.id} thread=${m.threadId} from=${m.sender}${tag}\n${m.body}`
}

export async function listenCommand(
  client: ListenClient,
  opts: ListenOptions,
  out: (line: string) => void,
): Promise<'delivered' | 'timeout'> {
  const deadline = Date.now() + opts.waitSeconds * 1000
  for (;;) {
    const remaining = deadline - Date.now()
    const { messages } = await client.inbox(Math.max(0, Math.min(POLL_CAP_MS, remaining)), opts.threadId)
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
```

- [ ] **Step 4: Run test to verify it passes, commit**

Run: `npx vitest run src/cli/commands.test.ts` — expected: all PASS

```powershell
git add src/cli
git commit -m "feat(cli): add listen loop and peer-thread resolution logic"
```

### Task 14: Admin functions + commander wiring

**Files:**
- Create: `src/cli/admin.ts`, `src/cli/index.ts`
- Test: `src/cli/admin.test.ts`

- [ ] **Step 1: Write the failing test** — `src/cli/admin.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { makeService } from '../core/testkit.js'
import { addAgent, createInvite, revokeAgent } from './admin.js'

describe('admin', () => {
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
    expect(h.service.authenticate(token).name).toBe('volumi')
    revokeAgent(h.store, 'volumi')
    expect(() => h.service.authenticate(token)).toThrow()
  })

  test('addAgent rejects a taken name', () => {
    const h = makeService()
    addAgent(h.store, h.clock, 'volumi')
    expect(() => addAgent(h.store, h.clock, 'volumi')).toThrow(/already/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/admin.test.ts`
Expected: FAIL — cannot find module `./admin.js`

- [ ] **Step 3: Write `src/cli/admin.ts`**

```ts
import type { AgentRecord, AgentStore, Clock, InviteStore } from '../core/ports.js'
import { hashSecret, newInviteCode, newToken } from '../core/tokens.js'

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/admin.test.ts`
Expected: all PASS

- [ ] **Step 5: Write `src/cli/index.ts`** (thin wiring — no logic; verified by typecheck/lint and the Task 15 story)

```ts
#!/usr/bin/env node
import { Command } from 'commander'
import { systemClock } from '../core/clock.js'
import { loadClientConfig, loadServerConfig } from '../core/config.js'
import { PhoneClient, registerAgent } from '../client/client.js'
import { startServer } from '../http/server.js'
import { SqliteStore } from '../store/sqlite.js'
import { addAgent, createInvite, listAgentRecords, revokeAgent } from './admin.js'
import { formatMessage, listenCommand, resolvePeerThread } from './commands.js'

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

const bodyFrom = async (m?: string): Promise<string> => m ?? (await readStdin())

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
    const res = await registerAgent(url as string, { name: o.name, inviteCode: o.invite }).catch(fail)
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
    const body = o.message // first message optional on call; no stdin fallback here
    const res = await client().call({ to: agent, subject: o.subject, body }).catch(fail)
    out(`call opened: thread #${res.thread.id} "${res.thread.subject}" with ${agent}`)
  })

program
  .command('send')
  .option('--thread <id>')
  .option('--to <agent>')
  .option('-m, --message <body>')
  .action(async (o: { thread?: string; to?: string; message?: string }) => {
    const c = client()
    const body = await bodyFrom(o.message)
    let threadId: number
    if (o.thread !== undefined) threadId = Number(o.thread)
    else if (o.to !== undefined) {
      const { threads } = await c.threads('open').catch(fail)
      threadId = resolvePeerThread(threads, o.to)
    } else return fail(new Error('pass --thread <id> or --to <agent>'))
    const res = await c.send({ threadId, body }).catch(fail)
    out(`sent #${res.message.id} to ${res.message.recipient} (thread #${threadId})`)
  })

program
  .command('listen')
  .option('--wait <seconds>', 'total seconds to wait', '3600')
  .option('--thread <id>')
  .option('--ack', 'auto-ack delivered messages', false)
  .action(async (o: { wait: string; thread?: string; ack: boolean }) => {
    const result = await listenCommand(
      client(),
      {
        waitSeconds: Number(o.wait),
        autoAck: o.ack,
        threadId: o.thread === undefined ? undefined : Number(o.thread),
      },
      out,
    ).catch(fail)
    process.exitCode = result === 'delivered' ? 0 : 2
  })

program.command('inbox').action(async () => {
  const res = await client().inbox().catch(fail)
  if (res.messages.length === 0) return out('no voicemail')
  for (const m of res.messages) out(formatMessage(m))
  out(`unacked - when processed, run: agentphone ack --through ${res.cursor}`)
})

program
  .command('ack')
  .option('--through <id>')
  .option('--all', 'ack everything currently in the inbox', false)
  .action(async (o: { through?: string; all: boolean }) => {
    const c = client()
    let through: number
    if (o.all) through = (await c.inbox().catch(fail)).cursor
    else if (o.through !== undefined) through = Number(o.through)
    else return fail(new Error('pass --through <id> or --all'))
    const res = await c.ack(through).catch(fail)
    out(`acked through #${res.ackedThroughMessageId}`)
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

admin
  .command('add <name>')
  .action((name: string) => {
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

admin
  .command('revoke <name>')
  .action((name: string) => {
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

- [ ] **Step 6: Typecheck, lint, full suite, commit**

```powershell
npm run typecheck
npm run lint
npm test
git add src/cli
git commit -m "feat(cli): wire commander surface with admin provisioning and serve"
```

---

## Phase 5 — Integration story + docs

### Task 15: End-to-end story test (incl. restart persistence)

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
import { startServer } from '../src/http/server.js'
import { SqliteStore } from '../src/store/sqlite.js'
import { createInvite } from '../src/cli/admin.js'

describe('the whole story', () => {
  test('register, call, listen-wake, voicemail, ack, hangup, restart persistence', async () => {
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
git commit -m "test(integration): pin the end-to-end story including restart persistence"
```

### Task 16: README, impl notes, final verification

**Files:**
- Create: `README.md`, `docs/increment-1-agentphone-core/impl.md`

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
when a message arrives, which re-invokes the agent with the message as output.
````

- [ ] **Step 2: Write `docs/increment-1-agentphone-core/impl.md`**

```markdown
# Increment 1 — implementation notes

## Decisions & deviations

(record here as they happen during execution)

## Review findings & resolutions

(parallel spec-conformance + code-quality reviews at each phase checkpoint)

## Deferred debt

(audit at task boundaries; nothing may hide in scattered review notes)

## Verification evidence

(final build/test/lint output summary, story-test result, both-OS notes)
```

- [ ] **Step 3: Final verification (all must pass)**

```powershell
npm run build
npm run typecheck
npm run lint
npm test
```

Expected: build emits `dist/agentphone.js`; typecheck/lint clean; full suite green.
Record the outcome in `impl.md` under Verification evidence.

- [ ] **Step 4: Smoke the built CLI end-to-end on this machine**

```powershell
node dist/agentphone.js admin invite
# in another shell: $env:AGENTPHONE_BIND="127.0.0.1"; node dist/agentphone.js serve
# then: node dist/agentphone.js register --name smoke-test --invite <code> --url http://127.0.0.1:4747
```

Expected: invite prints; registration prints a token. Clean up: `node dist/agentphone.js admin revoke smoke-test`, delete `agentphone.db*`.

- [ ] **Step 5: Commit**

```powershell
git add README.md docs/increment-1-agentphone-core/impl.md
git commit -m "docs: add quickstart readme and increment-1 impl notes scaffold"
```

**Final holistic review (per project CLAUDE.md):** one comprehensive review pass over the whole increment against design.md, plan.md, overview.md, and the conventions — then PR via `gh pr create --fill`, fix findings, re-verify, merge with `gh pr merge --merge --delete-branch`.

---

## Plan self-review (completed by plan author)

1. **Spec coverage:** every design verb, surface, error code, TTL rule, delivery guarantee, config key, observability requirement, and acceptance criterion maps to a task (verbs/TTL/delivery → Tasks 6-8; HTTP+auth → Task 10; MCP → Task 11; CLI incl. ring/stdin/--to → Tasks 13-14; invites/admin → Tasks 6/14; restart persistence + jsonl events → Task 15; both-OS quickstart → Task 16).
2. **Placeholder scan:** no TBDs; every code step carries the full code.
3. **Type consistency:** port method names, schema names, and `CallCtx`/`Surface` usage were cross-checked across Tasks 2-14 (e.g. `listUnacked(recipient, afterId, threadId?)` is identical in ports, store, service, and tests).



