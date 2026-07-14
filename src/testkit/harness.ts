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
