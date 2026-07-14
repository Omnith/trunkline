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
    // bind failures (e.g. EADDRINUSE) fire 'error', never the listen callback
    srv.once('error', reject)
  })
}
