// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { BREAKPOINT_QUERIES, useBreakpoint, useIsMobile } from './useBreakpoint'

type Listener = (event: MediaQueryListEvent) => void

class MatchMediaController {
  private width = 1024
  private readonly lists = new Set<MockMediaQueryList>()

  install(): void {
    vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
      const list = new MockMediaQueryList(query, () => this.matches(query))
      this.lists.add(list)
      return list as unknown as MediaQueryList
    })
  }

  setWidth(width: number): void {
    this.width = width
    for (const list of this.lists) {
      list.refresh()
    }
  }

  listenerCount(query: string): number {
    let count = 0
    for (const list of this.lists) {
      if (list.media === query) count += list.listenerCount()
    }
    return count
  }

  private matches(query: string): boolean {
    const maxWidth = /max-width:\s*(\d+)px/.exec(query)?.[1]
    const minWidth = /min-width:\s*(\d+)px/.exec(query)?.[1]

    if (maxWidth !== undefined && this.width > Number(maxWidth)) return false
    if (minWidth !== undefined && this.width < Number(minWidth)) return false
    return true
  }
}

class MockMediaQueryList {
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null = null
  private lastMatches: boolean
  private readonly listeners = new Set<Listener>()

  constructor(
    readonly media: string,
    private readonly computeMatches: () => boolean,
  ) {
    this.lastMatches = computeMatches()
  }

  get matches(): boolean {
    return this.computeMatches()
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === 'change') this.listeners.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === 'change') this.listeners.delete(listener)
  }

  addListener(listener: Listener): void {
    this.listeners.add(listener)
  }

  removeListener(listener: Listener): void {
    this.listeners.delete(listener)
  }

  dispatchEvent(): boolean {
    return true
  }

  listenerCount(): number {
    return this.listeners.size
  }

  refresh(): void {
    const nextMatches = this.computeMatches()
    if (nextMatches === this.lastMatches) return

    this.lastMatches = nextMatches
    const event = { matches: nextMatches, media: this.media } as MediaQueryListEvent
    this.onchange?.call(this as unknown as MediaQueryList, event)
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

describe('useBreakpoint', () => {
  let controller: MatchMediaController

  beforeEach(() => {
    controller = new MatchMediaController()
    controller.install()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reacts when a named breakpoint starts and stops matching', async () => {
    const scope = effectScope()
    const isMobile = scope.run(() => useIsMobile())

    expect(isMobile?.value).toBe(false)

    controller.setWidth(390)
    await nextTick()
    expect(isMobile?.value).toBe(true)

    controller.setWidth(900)
    await nextTick()
    expect(isMobile?.value).toBe(false)

    scope.stop()
  })

  it('accepts custom media queries and removes listeners on scope disposal', () => {
    const query = '(min-width: 640px) and (max-width: 1023px)'
    controller.setWidth(900)

    const scope = effectScope()
    const matches = scope.run(() => useBreakpoint(query))

    expect(matches?.value).toBe(true)
    expect(controller.listenerCount(query)).toBe(1)

    scope.stop()
    expect(controller.listenerCount(query)).toBe(0)
  })

  it('exposes the canonical mobile query', () => {
    expect(BREAKPOINT_QUERIES.mobile).toBe('(max-width: 767px)')
  })
})
