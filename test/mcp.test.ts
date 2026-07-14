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

// SDK 1.29 callTool returns a union that includes a legacy { toolResult } variant with no
// `content`; type the param via the SDK's own return type so the helper accepts it.
type ToolCallResult = Awaited<ReturnType<Client['callTool']>>

const textOf = (result: ToolCallResult): string => {
  const content = result.content as Array<{ type: string; text: string }>
  return content[0]?.text ?? ''
}

describe('mcp surface', () => {
  test('lists the ten verbs as tools, with listen defaulting waitMs to 25s', async () => {
    const { url, ghaToken } = await boot()
    const client = await connect(url, ghaToken)
    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'ack',
        'call',
        'checkin',
        'hangup',
        'history',
        'inbox',
        'listen',
        'phonebook',
        'send',
        'threads',
      ].sort(),
    )
    const listen = tools.find((t) => t.name === 'listen')
    // assert the 25s default is published at its precise JSON-schema location
    const waitMsSchema = (
      listen?.inputSchema as { properties?: Record<string, { default?: unknown }> }
    )?.properties?.waitMs
    expect(waitMsSchema?.default).toBe(25000)
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
