import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import IntentSessionPanel from './IntentSessionPanel.vue'
import MessageInput from '@/components/MessageInput/MessageInput.vue'
import PendingQueue from '@/components/PendingQueue/PendingQueue.vue'
import type { DetailTab } from './useIntentDetailTabs'

function mountPanel(over: Partial<Record<string, unknown>> = {}) {
  return mount(IntentSessionPanel, {
    props: {
      activeTab: 'intentSession' as DetailTab,
      expectedSessionId: null,
      chatReady: false,
      firstIntentTurn: false,
      intentTitle: 'Intent title',
      activeTitle: 'Active title',
      modeLocked: true,
      hasActiveSession: false,
      messages: [],
      actionablePermissionId: null,
      taskModel: { tasks: [] },
      running: false,
      teamActive: false,
      connection: 'open' as const,
      activity: { phase: 'idle' as const },
      queue: [],
      availableCommands: [],
      voiceLang: 'en-US',
      ...over,
    },
    global: {
      stubs: {
        ChatColumn: {
          props: ['showMode', 'modeDisabled', 'activeTitle'],
          emits: ['submit'],
          template:
            '<div data-testid="intent-detail-chat" :data-mode-disabled="String(modeDisabled)" :data-title="activeTitle"><button data-testid="do-submit" @click="$emit(\'submit\', \'hi\', [])" /></div>',
        },
      },
    },
  })
}

// 同上,但不打桩 ChatColumn:用于断言评审 tab 的只读呈现真的落到聊天列上。
function mountPanelWithRealChat(over: Partial<Record<string, unknown>> = {}) {
  return mount(IntentSessionPanel, {
    props: {
      activeTab: 'specReviewSession' as DetailTab,
      expectedSessionId: 'rev-1',
      chatReady: true,
      chatReadonly: true,
      firstIntentTurn: false,
      intentTitle: 'Intent title',
      activeTitle: 'Active title',
      modeLocked: true,
      hasActiveSession: true,
      messages: [],
      actionablePermissionId: null,
      taskModel: { tasks: [] },
      running: true,
      teamActive: false,
      connection: 'open' as const,
      activity: { phase: 'idle' as const },
      sideEffectPending: true,
      queue: [{ id: 1, text: 'queued', images: [] }],
      availableCommands: [],
      voiceLang: 'en-US',
      ...over,
    },
  })
}

describe('IntentSessionPanel.vue', () => {
  it('shows the spec/work empty state for non-intent session tabs without an expected id', () => {
    const work = mountPanel({ activeTab: 'workSession' })
    expect(work.find('[data-testid="intent-detail-work-session-empty"]').exists()).toBe(true)

    const spec = mountPanel({ activeTab: 'specSession' })
    expect(spec.find('[data-testid="intent-detail-spec-session-empty"]').exists()).toBe(true)

    const review = mountPanel({ activeTab: 'specReviewSession' })
    expect(review.find('[data-testid="intent-detail-spec-review-session-empty"]').exists()).toBe(
      true,
    )
  })

  it('renders the review tab chat read-only: no composer, queue, stop or continue', () => {
    const w = mountPanelWithRealChat()
    expect(w.findComponent(MessageInput).exists()).toBe(false)
    expect(w.findComponent(PendingQueue).exists()).toBe(false)
    expect(w.find('.status-stop').exists()).toBe(false)
    expect(w.find('.status-continue').exists()).toBe(false)
    // 状态栏与运行状态文字保留(评审进行中用户仍能看到)。
    expect(w.find('.status-bar').exists()).toBe(true)
    expect(w.find('.status-text').text().length).toBeGreaterThan(0)
  })

  it('keeps the other session tabs writable', () => {
    const w = mountPanelWithRealChat({ activeTab: 'specSession' as DetailTab, chatReadonly: false })
    expect(w.findComponent(MessageInput).exists()).toBe(true)
    expect(w.findComponent(PendingQueue).exists()).toBe(true)
    expect(w.find('.status-stop').exists()).toBe(true)
  })

  it('shows the loading placeholder when an id is expected but not yet aligned', () => {
    const w = mountPanel({ activeTab: 'specSession', expectedSessionId: 'sess', chatReady: false })
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(false)
    expect(w.find('.intent-detail-empty').exists()).toBe(true)
  })

  it('renders the chat column once the active session aligns, locking the mode off work tabs', () => {
    const w = mountPanel({ expectedSessionId: 'sess', chatReady: true, modeLocked: true })
    const chat = w.find('[data-testid="intent-detail-chat"]')
    expect(chat.exists()).toBe(true)
    expect(chat.attributes('data-mode-disabled')).toBe('true')
  })

  it('renders the first-turn chat with the intent title and forwards submit', async () => {
    const w = mountPanel({ firstIntentTurn: true, modeLocked: false })
    const chat = w.find('[data-testid="intent-detail-chat"]')
    expect(chat.exists()).toBe(true)
    expect(chat.attributes('data-title')).toBe('Intent title')
    expect(chat.attributes('data-mode-disabled')).toBe('false')

    await w.find('[data-testid="do-submit"]').trigger('click')
    expect(w.emitted('submit')).toEqual([['hi', []]])
  })
})
