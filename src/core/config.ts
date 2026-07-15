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
  if (!url) throw new Error('AGENTPHONE_URL is required (e.g. http://<server-ip>:4747)')
  const token = env.AGENTPHONE_TOKEN
  if (!token) throw new Error('AGENTPHONE_TOKEN is required (mint one via invite or admin add)')
  return { url, token }
}
