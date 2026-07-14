#!/usr/bin/env node
import { Command } from 'commander'
import { systemClock } from '../core/clock.js'
import { loadClientConfig, loadServerConfig } from '../core/config.js'
import { addAgent, createInvite, listAgentRecords, revokeAgent } from '../core/provisioning.js'
import { PhoneClient, registerAgent } from '../client/client.js'
import { startServer } from '../http/server.js'
import { SqliteStore } from '../store/sqlite.js'
import { ackAll, bodyFrom, exitCodeFor, formatMessage, listenCommand, sendTo } from './commands.js'

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
    const res = await client().call({ to: agent, subject: o.subject, body: o.message }).catch(fail)
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
