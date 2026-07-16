import { describe, expect, test } from 'vitest'
import type { ListenOutput, MessageView, SendInput, ThreadView } from '../core/contracts.js'
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
    expect(() => resolvePeerThread([], 'volumi')).toThrow(/trunkline call volumi/)
  })
  test('errors listing candidates when ambiguous', () => {
    const threads = [threadView(1, 'ci', 'open'), threadView(2, 'infra', 'open')]
    expect(() => resolvePeerThread(threads, 'volumi')).toThrow(/#1.*#2/s)
  })
  test('falls back to the most recent ended thread when no open call exists (late reply reopens)', () => {
    const threads = [
      threadView(9, 'newest-ended', 'ended'),
      threadView(4, 'older-ended', 'ended'),
      threadView(3, 'other-peer-open', 'open', ['gha-docker-runner', 'lab7']),
    ]
    expect(resolvePeerThread(threads, 'volumi')).toBe(9)
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
    const result = await listenCommand(client, { waitSeconds: 5, autoAck: false }, (s) =>
      out.push(s),
    )
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
    const result = await listenCommand(client, { waitSeconds: 0, autoAck: false }, (s) =>
      out.push(s),
    )
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
    const sent: SendInput[] = []
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

  test('forwards ackThrough to send when given (reply+ack in one round)', async () => {
    const sent: SendInput[] = []
    const client: SendToClient = {
      threads: () => Promise.resolve({ threads: [threadView(4, 'ci', 'open')] }),
      send: (input) => {
        sent.push(input)
        return Promise.resolve({ message: msg(9, input.body) })
      },
    }
    await sendTo(client, 'volumi', 'hi', 7)
    expect(sent).toEqual([{ threadId: 4, body: 'hi', ackThrough: 7 }])
  })

  test('propagates resolution errors (no thread at all)', async () => {
    const client: SendToClient = {
      threads: () => Promise.resolve({ threads: [] }),
      send: () => Promise.reject(new Error('should not send')),
    }
    await expect(sendTo(client, 'volumi', 'x')).rejects.toThrow(/no open thread/)
  })

  test('reaches an ended call when no open one exists (reopen-on-send)', async () => {
    const sent: SendInput[] = []
    const client: SendToClient = {
      threads: () => Promise.resolve({ threads: [threadView(7, 'done', 'ended')] }),
      send: (input) => {
        sent.push(input)
        return Promise.resolve({ message: msg(11, input.body) })
      },
    }
    await sendTo(client, 'volumi', 'one more thing')
    expect(sent).toEqual([{ threadId: 7, body: 'one more thing' }])
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
