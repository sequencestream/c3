// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import MobileStack from './MobileStack.vue'
import type { MobileStackPane } from './MobileStack.vue'

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

  dispatchEvent(): boolean {
    return true
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

const PANES: readonly MobileStackPane[] = [
  { key: 'list', title: 'List' },
  { key: 'detail', title: 'Detail' },
  { key: 'deep', title: 'Deep Detail' },
]

function mountStack(
  options: { activeKey?: string | null; activeToken?: string | number | null } = {},
) {
  return mount(MobileStack, {
    props: {
      panes: PANES,
      ...options,
    },
    slots: {
      list: '<div data-testid="list-pane">List Pane</div>',
      detail: '<div data-testid="detail-pane">Detail Pane</div>',
      deep: '<div data-testid="deep-pane">Deep Pane</div>',
    },
  })
}

describe('MobileStack.vue', () => {
  let controller: MatchMediaController

  beforeEach(() => {
    controller = new MatchMediaController()
    controller.install()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('passes through all panes on desktop', () => {
    controller.setWidth(1280)
    const wrapper = mountStack({ activeKey: 'detail' })

    expect(wrapper.find('[data-testid="mobile-stack-desktop"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-stack-mobile"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="list-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="deep-pane"]').exists()).toBe(true)
  })

  it('pushes the active detail pane on mobile and pops back to list', async () => {
    controller.setWidth(390)
    const wrapper = mountStack({ activeKey: 'list' })

    expect(wrapper.find('[data-testid="list-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-stack-back"]').exists()).toBe(false)

    await wrapper.setProps({ activeKey: 'detail', activeToken: 'item-1' })
    await nextTick()
    expect(wrapper.find('[data-pane-key="detail"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="detail-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-stack-back"]').exists()).toBe(true)

    await wrapper.find('[data-testid="mobile-stack-back"]').trigger('click')
    expect(wrapper.find('[data-pane-key="list"]').exists()).toBe(true)
    expect(wrapper.emitted('back')).toEqual([['list']])
  })

  it('supports a three-pane stack and emits each return target', async () => {
    controller.setWidth(390)
    const wrapper = mountStack({ activeKey: 'list' })

    await wrapper.setProps({ activeKey: 'detail', activeToken: 'item-1' })
    await wrapper.setProps({ activeKey: 'deep', activeToken: 'run-1' })

    expect(wrapper.find('[data-pane-key="deep"]').exists()).toBe(true)

    await wrapper.find('[data-testid="mobile-stack-back"]').trigger('click')
    expect(wrapper.find('[data-pane-key="detail"]').exists()).toBe(true)

    await wrapper.find('[data-testid="mobile-stack-back"]').trigger('click')
    expect(wrapper.find('[data-pane-key="list"]').exists()).toBe(true)
    expect(wrapper.emitted('back')).toEqual([['detail'], ['list']])
  })
})
