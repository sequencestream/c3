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
 * How many passes one `request()` may chain before the runner stops driving and
 * leaves the rest to the next tick. A pass that re-requests itself is normal —
 * that is how a launch settles into the pass which observes it — but a pass whose
 * re-request is not backed by any progress would otherwise drive forever. The
 * cap costs nothing legitimate: a workspace settles in a handful of passes, and
 * whatever is left is re-derived on the fixed cadence anyway.
 */
const MAX_CHAINED_PASSES = 64

/** Hand the event loop one full turn, so a chained pass cannot starve I/O. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Serialises an async pass and coalesces overlapping requests. A request made
 * while a pass is running schedules exactly ONE follow-up pass, no matter how
 * many arrive — the same "merge, never drop" rule the dirty set applies to keys.
 *
 * Follow-ups are separated by a macrotask turn and bounded in number. Both exist
 * for the same failure: a pass that requests itself with nothing changed. Chained
 * purely through promises it would keep the loop inside the microtask queue, and
 * the event loop would never reach its poll phase again — the process burns a
 * core while HTTP stops answering and even a termination signal never reaches its
 * handler. Yielding keeps the process responsive; the cap keeps it from spinning.
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
      for (let chained = 1; ; chained++) {
        this.again = false
        await this.pass()
        if (!this.again) return
        if (chained >= MAX_CHAINED_PASSES) {
          this.again = false
          console.warn(
            `[c3:queue] 一次请求已连续驱动 ${MAX_CHAINED_PASSES} 轮对账仍未收敛,` +
              '本轮停止驱动,交由固定节拍继续',
          )
          return
        }
        await yieldToEventLoop()
      }
    } finally {
      this.running = null
    }
  }
}
