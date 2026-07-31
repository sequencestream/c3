/**
 * Queue scheduling kernel — coalescing tests.
 *
 * The contract these protect: marks MERGE, and a mark that arrives while a pass
 * is running is served by a follow-up pass rather than dropped. That is what
 * makes "events are only hints" safe — a burst costs one extra pass, and nothing
 * a caller asked for goes unanswered.
 */
import { describe, expect, it } from 'vitest'
import { CoalescingDirtySet, CoalescingRunner } from './dirty-set.js'

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
    await Promise.resolve()
    await Promise.resolve()
    expect(passes).toBe(2)
    release!()
    await Promise.all([first, ...followers])
    expect(passes).toBe(2)
    expect(runner.isRunning).toBe(false)
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
