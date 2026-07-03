// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import Works from './Works.vue'
import type { SessionInfo } from '@ccc/shared/protocol'

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

const WS = '/repo'
const SESSIONS: SessionInfo[] = [
  {
    sessionId: 's1',
    title: 'Session one',
    lastModified: 1,
    mode: 'default',
    isToolSession: false,
    vendor: 'claude',
  },
]

const WorkSessionListStub = defineComponent({
  name: 'WorkSessionList',
  props: {
    currentWorkspace: { type: String, default: null },
  },
  emits: ['select-session'],
  template: `
    <div data-testid="sessions-slot">
      <button data-testid="select-session" @click="$emit('select-session', currentWorkspace, 's1')">
        Session one
      </button>
    </div>
  `,
})

function mountWorks(options: { activeSession?: string | null } = {}) {
  return mount(Works, {
    props: {
      currentWorkspace: WS,
      sessions: SESSIONS,
      activeSessionKind: 'work',
      sessionCounts: { work: 0, intent: 0, spec: 0, discussion: 0, automation: 0, tool: 0 },
      showToolSessions: false,
      sessionStatus: {},
      activeWorkspace: WS,
      activeSession: options.activeSession ?? null,
      activeTitle: 'Session one',
      hasActiveSession: options.activeSession !== null && options.activeSession !== undefined,
      mode: 'default',
      codexPolicy: null,
      modeOptions: [{ value: 'default', label: 'Default' }],
      messages: [],
      actionablePermissionId: null,
      taskModel: { tasks: [] },
      running: false,
      teamActive: false,
      connection: 'open',
      activity: { phase: 'idle' },
      queue: [],
      availableCommands: [],
      voiceLang: 'en-US',
    },
    global: {
      stubs: {
        WorkSessionList: WorkSessionListStub,
        SessionTitleBar: { template: '<div data-testid="title-bar" />' },
        ChatMessages: { template: '<div data-testid="chat-slot" />' },
        TaskPanel: { template: '<div />' },
        SessionStatusBar: { template: '<div />' },
        PendingQueue: { template: '<div />' },
        MessageInput: { template: '<div />', methods: { prefill: vi.fn() } },
      },
    },
  })
}

describe('Works.vue mobile drill-down', () => {
  let controller: MatchMediaController

  beforeEach(() => {
    controller = new MatchMediaController()
    controller.install()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts on the session list on mobile even with an active session', () => {
    controller.setWidth(390)
    const wrapper = mountWorks({ activeSession: 's1' })

    expect(wrapper.find('[data-testid="mobile-stack-mobile"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sessions-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-slot"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-stack-back"]').exists()).toBe(false)
  })

  it('drills into chat on session selection and returns to the list on back', async () => {
    controller.setWidth(390)
    const wrapper = mountWorks()

    await wrapper.find('[data-testid="select-session"]').trigger('click')
    await nextTick()

    expect(wrapper.emitted('select-session')).toEqual([[WS, 's1']])
    expect(wrapper.find('[data-testid="chat-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sessions-slot"]').exists()).toBe(false)

    await wrapper.find('[data-testid="mobile-stack-back"]').trigger('click')
    await nextTick()

    expect(wrapper.find('[data-testid="sessions-slot"]').exists()).toBe(true)
    expect(wrapper.emitted('mobile-back')).toEqual([['sessions']])
  })

  it('keeps both panes rendered on desktop', () => {
    controller.setWidth(1280)
    const wrapper = mountWorks({ activeSession: 's1' })

    expect(wrapper.find('[data-testid="mobile-stack-desktop"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sessions-slot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-slot"]').exists()).toBe(true)
  })
})
