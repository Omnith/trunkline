import type { AddressInfo } from 'node:net'
import { systemClock } from '../core/clock.js'
import type { ServerConfig } from '../core/config.js'
import { HOUR_MS } from '../core/ports.js'
import { PhoneService } from '../core/service.js'
import { handleMcpRequest } from '../mcp/tools.js'
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
  const service = new PhoneService(store, emitter, systemClock, cfg.threadTtlHours * HOUR_MS)
  const app = buildApp({ service, emitter, clock: systemClock, mcpHandler: handleMcpRequest })
  return new Promise((resolve, reject) => {
    const srv = app.listen(cfg.port, cfg.bind, () => {
      const port = (srv.address() as AddressInfo).port
      // graceful shutdown: release parked long-polls first so they respond empty, then close.
      // undici pools keep-alive sockets that srv.close() will not reap on its own, so keep
      // reaping idle sockets on a short unref'd interval until close completes - this only ever
      // touches idle sockets, so the just-released responses are never truncated.
      let closing: Promise<void> | undefined
      const doClose = (): Promise<void> => {
        const start = systemClock.now()
        service.releaseWaiters()
        return new Promise<void>((done) => {
          const reaper = setInterval(() => srv.closeIdleConnections(), 25)
          reaper.unref()
          srv.close(() => {
            clearInterval(reaper)
            // the close promise must always settle, even if store/emitter throw
            try {
              store.close()
              emitter.emit({
                ts: start,
                op: 'shutdown',
                surface: 'http',
                agent: null,
                outcome: 'ok',
                durationMs: systemClock.now() - start,
              })
            } finally {
              done()
            }
          })
          srv.closeIdleConnections()
        })
      }
      resolve({
        port,
        close: () => (closing ??= doClose()),
      })
    })
    // bind failures (e.g. EADDRINUSE) fire 'error', never the listen callback
    srv.once('error', reject)
  })
}
