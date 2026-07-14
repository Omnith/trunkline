// in-process long-poll registry: one Set of wakeup callbacks per agent name
export class Waiters {
  private readonly parked = new Map<string, Set<() => void>>()

  isListening(agent: string): boolean {
    return (this.parked.get(agent)?.size ?? 0) > 0
  }

  notify(agent: string): void {
    const set = this.parked.get(agent)
    if (!set) return
    for (const wake of [...set]) wake()
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
