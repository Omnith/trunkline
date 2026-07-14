import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Emitter, PhoneEvent } from '../core/ports.js'

// note: synchronous append on the hot path - fine at two-agent scale (see impl.md deferred debt)
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
