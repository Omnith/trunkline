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
