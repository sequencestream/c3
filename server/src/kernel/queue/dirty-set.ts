/**
 * Queue scheduling kernel — the coalescing dirty set.
 *
 * Events do not carry decision material and are never replayed. All they do is
 * say "this workspace (optionally: this intent) deserves another look". Repeated
 * marks for the same key collapse into one, and a mark that arrives WHILE a pass
 * is draining is kept for the NEXT drain rather than dropped — so a burst of
 * lifecycle events costs one extra pass, and a lost event costs one tick of
 * latency instead of a stalled queue.
 */

/** A set of keys that need re-checking, with duplicate marks merged. */
export class CoalescingDirtySet<T> {
  private pending = new Set<T>()

  /** Mark a key dirty. Repeat marks for the same key collapse into one. */
  mark(key: T): void {
    this.pending.add(key)
  }

  /** Whether a key is currently marked. */
  has(key: T): boolean {
    return this.pending.has(key)
  }

  get size(): number {
    return this.pending.size
  }

  /**
   * Take every currently-marked key and clear the set. Marks made after this
   * call — including from inside the pass this drain feeds — accumulate for the
   * next drain and are never lost.
   */
  drain(): T[] {
    if (this.pending.size === 0) return []
    const taken = [...this.pending]
    this.pending = new Set<T>()
    return taken
  }

  /** Drop every mark (used when a workspace's queue is torn down). */
  clear(): void {
    this.pending = new Set<T>()
  }
}

/**
 * Serialises an async pass and coalesces overlapping requests. A request made
 * while a pass is running schedules exactly ONE follow-up pass, no matter how
 * many arrive — the same "merge, never drop" rule the dirty set applies to keys.
 */
export class CoalescingRunner {
  private running: Promise<void> | null = null
  private again = false

  constructor(private readonly pass: () => Promise<void>) {}

  /** True while a pass is executing. */
  get isRunning(): boolean {
    return this.running !== null
  }

  /**
   * Request a pass. Resolves when the pass that covers this request has
   * finished (the currently running one plus, if it was already busy, the
   * follow-up it schedules).
   */
  request(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.drive()
    return this.running
  }

  private async drive(): Promise<void> {
    try {
      do {
        this.again = false
        await this.pass()
      } while (this.again)
    } finally {
      this.running = null
    }
  }
}
