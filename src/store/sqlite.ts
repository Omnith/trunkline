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
      (this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as
        AgentRecord | undefined) ?? null
    )
  }
  getAgentByTokenHash(hash: string): AgentRecord | null {
    return (
      (this.db.prepare('SELECT * FROM agents WHERE tokenHash = ?').get(hash) as
        AgentRecord | undefined) ?? null
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
        InviteRecord | undefined) ?? null
    )
  }
  markInviteUsed(id: number, usedBy: string, usedAt: number): void {
    this.db
      .prepare('UPDATE invites SET usedBy = ?, usedAt = ? WHERE id = ?')
      .run(usedBy, usedAt, id)
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
