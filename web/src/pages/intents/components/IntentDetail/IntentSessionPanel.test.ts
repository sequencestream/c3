import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import IntentSessionPanel from './IntentSessionPanel.vue'
import MessageInput from '@/components/MessageInput/MessageInput.vue'
import PendingQueue from '@/components/PendingQueue/PendingQueue.vue'
import ChatMessages from '@/components/ChatMessages/ChatMessages.vue'
import TaskPanel from '@/components/TaskPanel/TaskPanel.vue'
import SessionStatusBar from '@/components/SessionStatusBar/SessionStatusBar.vue'
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
          props: ['showMode', 'modeDisabled', 'activeTitle', 'sessionBound'],
          emits: ['submit'],
          template:
            '<div data-testid="intent-detail-chat" :data-mode-disabled="String(modeDisabled)" :data-title="activeTitle" :data-session-bound="String(sessionBound)"><button data-testid="do-submit" @click="$emit(\'submit\', \'hi\', [])" /></div>',
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

// 意图会话首轮(firstIntentTurn,期望会话未就绪)用真实 ChatColumn 断言:聊天列
// 必须只呈现标题与首条输入框,不泄漏任何旧会话派生的 task / agent / 状态栏 / 消息。
function mountFirstTurnRealChat(over: Partial<Record<string, unknown>> = {}) {
  return mount(IntentSessionPanel, {
    props: {
      activeTab: 'intentSession' as DetailTab,
      expectedSessionId: null,
      chatReady: false,
      chatReadonly: false,
      firstIntentTurn: true,
      intentTitle: 'Intent title',
      activeTitle: 'Old active title',
      modeLocked: true,
      hasActiveSession: false,
      // 塞入非空旧会话字段:若门控失效,以下每一项都会从上一会话泄漏进首轮视图。
      messages: [{ kind: 'assistant', id: 9, text: 'stale' }],
      actionablePermissionId: 'req-stale',
      taskModel: {
        tasks: [{ id: 't1', subject: 'stale task', status: 'in_progress', order: 0 }],
      },
      running: true,
      teamActive: true,
      connection: 'open' as const,
      activity: { phase: 'thinking' as const },
      currentAgentName: 'Old Agent',
      reconnecting: true,
      sideEffectPending: true,
      queue: [{ id: 1, text: 'stale queued', images: [] }],
      availableCommands: [],
      voiceLang: 'en-US',
      vendor: 'claude',
      agentSwitch: {
        current: { id: 'a', displayName: 'A' },
        candidates: [{ id: 'b', displayName: 'B' }],
        currentUnavailable: false,
      },
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

  it('shows the loading placeholder when an id is expected but not yet aligned (stale fields do not leak)', () => {
    const w = mountPanel({
      activeTab: 'specSession',
      expectedSessionId: 'sess',
      chatReady: false,
      // 塞入非空旧会话字段:未对齐时聊天列根本不挂载,旧 task / agent / 状态栏 / 消息无处泄漏。
      taskModel: { tasks: [{ id: 't1', subject: 'stale', status: 'in_progress', order: 0 }] },
      vendor: 'claude',
      activity: { phase: 'thinking' as const },
      currentAgentName: 'Old Agent',
    })
    expect(w.find('[data-testid="intent-detail-chat"]').exists()).toBe(false)
    expect(w.find('.intent-detail-empty').exists()).toBe(true)
  })

  it('renders the chat column once the active session aligns, locking the mode off work tabs', () => {
    const w = mountPanel({ expectedSessionId: 'sess', chatReady: true, modeLocked: true })
    const chat = w.find('[data-testid="intent-detail-chat"]')
    expect(chat.exists()).toBe(true)
    expect(chat.attributes('data-mode-disabled')).toBe('true')
    // 对齐后 sessionBound=true:该会话自身的展示状态允许渲染。
    expect(chat.attributes('data-session-bound')).toBe('true')
  })

  it('renders the first-turn chat with the intent title and forwards submit', async () => {
    const w = mountPanel({ firstIntentTurn: true, modeLocked: false })
    const chat = w.find('[data-testid="intent-detail-chat"]')
    expect(chat.exists()).toBe(true)
    expect(chat.attributes('data-title')).toBe('Intent title')
    expect(chat.attributes('data-mode-disabled')).toBe('false')
    // 首轮期望会话未就绪 → 聊天列 sessionBound=false,不渲染旧会话状态。
    expect(chat.attributes('data-session-bound')).toBe('false')

    await w.find('[data-testid="do-submit"]').trigger('click')
    expect(w.emitted('submit')).toEqual([['hi', []]])
  })

  it('first-intent-turn 不泄漏旧会话的 task / agent / 状态栏 / 消息,只留标题与首条输入框', () => {
    const w = mountFirstTurnRealChat()
    // 旧会话派生的区块全部被门控归零。
    expect(w.findComponent(ChatMessages).exists()).toBe(false)
    expect(w.findComponent(TaskPanel).exists()).toBe(false)
    expect(w.findComponent(SessionStatusBar).exists()).toBe(false)
    expect(w.findComponent(PendingQueue).exists()).toBe(false)
    // 标题栏保留,且用新意图自身标题,不显示旧 activeTitle。
    const bar = w.find('.session-title-bar')
    expect(bar.exists()).toBe(true)
    expect(bar.find('.session-title-text').text()).toBe('Intent title')
    // 无 vendor 点 / agent 切换 / 模式下拉(旧 agent 选择不泄漏)。
    expect(w.find('[data-testid="session-vendor-dot"]').exists()).toBe(false)
    expect(w.find('[data-testid="session-vendor-label"]').exists()).toBe(false)
    expect(w.find('[data-testid="session-agent-switch"]').exists()).toBe(false)
    // 首条输入框保留,且首轮可输入(has-active-session 由调用方强制 true)。
    const input = w.findComponent(MessageInput)
    expect(input.exists()).toBe(true)
    expect(input.props('hasActiveSession')).toBe(true)
  })

  it('chatReady 对齐后渲染该会话自身的消息 / 任务列表 / 状态栏,不被门控误清', () => {
    const w = mountPanelWithRealChat({
      activeTab: 'workSession' as DetailTab,
      chatReadonly: false,
      expectedSessionId: 'work-1',
      messages: [{ kind: 'assistant', id: 5, text: 'own message' }],
      taskModel: {
        tasks: [{ id: 't1', subject: 'own task', status: 'in_progress', order: 0 }],
      },
      currentAgentName: 'Own Agent',
    })
    expect(w.findComponent(ChatMessages).exists()).toBe(true)
    expect(w.findComponent(TaskPanel).exists()).toBe(true)
    expect(w.findComponent(SessionStatusBar).exists()).toBe(true)
    expect(w.findComponent(PendingQueue).exists()).toBe(true)
    expect(w.findComponent(MessageInput).exists()).toBe(true)
  })
})
