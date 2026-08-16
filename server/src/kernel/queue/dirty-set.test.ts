/**
 * Queue scheduling kernel — coalescing tests.
 *
 * The contract these protect: marks MERGE, and a mark that arrives while a pass
 * is running is served by a follow-up pass rather than dropped. That is what
 * makes "events are only hints" safe — a burst costs one extra pass, and nothing
 * a caller asked for goes unanswered.
 */
import { describe, expect, it, vi } from 'vitest'
import { CoalescingDirtySet, CoalescingRunner } from './dirty-set.js'

/** Let the event loop complete one full turn (timers and I/O included). */
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

describe('CoalescingDirtySet', () => {
  it('merges repeat marks for the same key', () => {
    const set = new CoalescingDirtySet<string>()
    set.mark('a')
    set.mark('a')
    set.mark('b')
    expect(set.size).toBe(2)
    expect(set.drain().sort()).toEqual(['a', 'b'])
    expect(set.size).toBe(0)
  })

  it('keeps marks made during a drain for the NEXT drain', () => {
    const set = new CoalescingDirtySet<string>()
    set.mark('a')
    const taken = set.drain()
    // Simulates an event landing while the pass fed by `taken` is still running.
    set.mark('b')
    expect(taken).toEqual(['a'])
    expect(set.drain()).toEqual(['b'])
  })

  it('drains empty without allocating a pass', () => {
    expect(new CoalescingDirtySet<string>().drain()).toEqual([])
  })
})

describe('CoalescingRunner', () => {
  it('runs one pass at a time and collapses concurrent requests into one follow-up', async () => {
    let running = 0
    let passes = 0
    let release: (() => void) | null = null
    const runner = new CoalescingRunner(async () => {
      running += 1
      expect(running).toBe(1) // never re-entered
      passes += 1
      await new Promise<void>((r) => {
        release = r
      })
      running -= 1
    })

    const first = runner.request()
    await Promise.resolve()
    expect(passes).toBe(1)

    // Five requests arrive mid-pass; they must produce exactly ONE follow-up.
    const followers = [runner.request(), runner.request(), runner.request()]
    release!()
    // The follow-up is deliberately one macrotask away: one turn settles the
    // released pass, the next runs the follow-up.
    await tick()
    await tick()
    expect(passes).toBe(2)
    release!()
    await Promise.all([first, ...followers])
    expect(passes).toBe(2)
    expect(runner.isRunning).toBe(false)
  })

  it('yields the event loop between chained passes, so a self-requesting pass never starves I/O', async () => {
    let passes = 0
    // A macrotask queued before the first pass. Chained purely through promises,
    // it cannot run until the whole chain is over.
    let pendingWorkRan = false
    setImmediate(() => {
      pendingWorkRan = true
    })
    const observed: boolean[] = []
    const runner = new CoalescingRunner(async () => {
      passes += 1
      observed.push(pendingWorkRan)
      await Promise.resolve()
      // The shape that used to wedge the process: a pass asking for another one
      // with nothing behind the request but promises.
      if (passes < 5) void runner.request()
    })

    await runner.request()

    expect(passes).toBe(5)
    // Every pass after the first sees the queued macrotask already served.
    expect(observed).toEqual([false, true, true, true, true])
  })

  it('stops driving at the chained-pass cap instead of spinning forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let passes = 0
    // Never converges: every pass re-requests itself and nothing ever changes.
    const runner = new CoalescingRunner(async () => {
      passes += 1
      await Promise.resolve()
      void runner.request()
    })

    await runner.request()

    expect(passes).toBe(64)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(runner.isRunning).toBe(false)
    warn.mockRestore()
  })

  it('a throwing pass does not wedge the runner', async () => {
    let calls = 0
    const runner = new CoalescingRunner(async () => {
      calls += 1
      await Promise.resolve()
      if (calls === 1) throw new Error('boom')
    })
    await expect(runner.request()).rejects.toThrow('boom')
    expect(runner.isRunning).toBe(false)
    await runner.request()
    expect(calls).toBe(2)
  })
})
