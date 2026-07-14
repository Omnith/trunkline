import type { Clock } from './ports.js'

export const systemClock: Clock = { now: () => Date.now() }
