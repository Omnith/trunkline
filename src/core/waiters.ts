// in-process long-poll registry: one Set of wakeup callbacks per agent name
export class Waiters {
  private readonly parked = new Map<string, Set<() => void>>()
  // one-way latch: once draining, long-polls return empty immediately - shutdown only
  private draining = false

  isListening(agent: string): boolean {
    return (this.parked.get(agent)?.size ?? 0) > 0
  }

  isDraining(): boolean {
    return this.draining
  }

  notify(agent: string): void {
    const set = this.parked.get(agent)
    if (!set) return
    for (const wake of [...set]) wake()
  }

  // shutdown: wake every parked waiter and flip draining so the listen loop exits instead of re-parking
  releaseAll(): void {
    this.draining = true
    for (const agent of [...this.parked.keys()]) this.notify(agent)
  }

  wait(agent: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.parked.get(agent) ?? new Set<() => void>()
      this.parked.set(agent, set)
      const wake = (): void => {
        set.delete(wake)
        if (set.size === 0) this.parked.delete(agent)
        clearTimeout(timer)
        resolve()
      }
      set.add(wake)
      const timer = setTimeout(wake, ms)
    })
  }
}
