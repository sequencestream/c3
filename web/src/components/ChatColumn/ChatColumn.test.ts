import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatColumn from './ChatColumn.vue'
import MessageInput from '../MessageInput/MessageInput.vue'
import PendingQueue from '../PendingQueue/PendingQueue.vue'
import ChatMessages from '../ChatMessages/ChatMessages.vue'
import TaskPanel from '../TaskPanel/TaskPanel.vue'
import SessionStatusBar from '../SessionStatusBar/SessionStatusBar.vue'
import SessionTitleBar from '../SessionTitleBar/SessionTitleBar.vue'
import type { ChatMsg, PermissionMsg } from '../../lib/chat-types'

/*
 * ChatColumn 的 `readonly` 能力门。只读会话(spec_review)只能回放:整列不得出现
 * 任何能改变会话、待发队列或权限决策的控件,并且即便子组件被程序化触发,只读分支
 * 也不能把这些变更事件上抛给上层。状态栏本身、状态文字、刷新与历史权限消息必须保留。
 * 断言只看结构 / 组件存在性 / emitted,不看文案。
 */

const PERMISSION: PermissionMsg = {
  kind: 'permission',
  id: 1,
  requestId: 'req-1',
  tool: 'Bash',
  input: { command: 'ls' },
  decision: null,
  isUserInteraction: false,
} as unknown as PermissionMsg

const MESSAGES: ChatMsg[] = [
  { kind: 'text', id: 2, role: 'assistant', text: 'reviewed' } as unknown as ChatMsg,
  PERMISSION,
]

function mountColumn(over: Partial<Record<string, unknown>> = {}) {
  return mount(ChatColumn, {
    props: {
      activeTitle: 'Review session',
      hasActiveSession: true,
      messages: MESSAGES,
      actionablePermissionId: 'req-1',
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

describe('ChatColumn.vue — 只读能力门', () => {
  it('默认(可写)会话保留输入框、待发队列与运行控制', () => {
    const w = mountColumn()
    expect(w.findComponent(MessageInput).exists()).toBe(true)
    expect(w.findComponent(PendingQueue).exists()).toBe(true)
    expect(w.find('.status-stop').exists()).toBe(true)
    expect(w.find('.status-continue').exists()).toBe(true)
    // 可操作权限仍下发给消息区 → 渲染 allow/deny 控件。
    expect(w.findComponent(ChatMessages).props('actionablePermissionId')).toBe('req-1')
    expect(w.find('.permission .actions').exists()).toBe(true)
  })

  it('只读会话移除 composer / 待发队列 / stop / continue,但保留状态栏与刷新', () => {
    const w = mountColumn({ readonly: true })
    expect(w.findComponent(MessageInput).exists()).toBe(false)
    expect(w.findComponent(PendingQueue).exists()).toBe(false)
    expect(w.find('.status-stop').exists()).toBe(false)
    expect(w.find('.status-continue').exists()).toBe(false)
    // 状态栏与其状态文字、刷新按钮保持可见(实时运行状态仍可观察)。
    const bar = w.findComponent(SessionStatusBar)
    expect(bar.exists()).toBe(true)
    expect(bar.find('.status-text').text().length).toBeGreaterThan(0)
    expect(bar.find('.status-refresh').exists()).toBe(true)
  })

  it('只读会话仍完整回放消息与历史权限请求,但不渲染 allow / deny / ask 控件', async () => {
    const w = mountColumn({ readonly: true })
    const msgs = w.findComponent(ChatMessages)
    expect(msgs.exists()).toBe(true)
    // 消息一条不少地传给消息区(历史与权限请求都不丢)。
    expect(msgs.props('messages')).toHaveLength(2)
    // 可操作权限被降级为历史:不再有任何决策控件。
    expect(msgs.props('actionablePermissionId')).toBe(null)
    expect(w.find('.actions').exists()).toBe(false)

    // 展开工具批次后,该权限请求仍以静态历史行呈现(可核验),依然没有决策控件。
    await w.find('.batch-head').trigger('click')
    expect(w.find('.perm-history').exists()).toBe(true)
    expect(w.find('.actions').exists()).toBe(false)
  })

  it('只读会话即便子组件被程序化触发也不上抛任何变更事件', async () => {
    const w = mountColumn({ readonly: true })
    const msgs = w.findComponent(ChatMessages)
    msgs.vm.$emit('respond', PERMISSION, 'allow')
    msgs.vm.$emit('submit-ask', PERMISSION, { a: 'b' })
    const bar = w.findComponent(SessionStatusBar)
    bar.vm.$emit('stop')
    bar.vm.$emit('continue')
    bar.vm.$emit('refresh')
    await w.vm.$nextTick()

    expect(w.emitted('respond')).toBeUndefined()
    expect(w.emitted('submit-ask')).toBeUndefined()
    expect(w.emitted('stop')).toBeUndefined()
    expect(w.emitted('continue')).toBeUndefined()
    // 刷新不是变更能力,仍然透传。
    expect(w.emitted('refresh')).toHaveLength(1)
  })

  it('可写会话的相同事件正常上抛(只读门不影响其他会话)', async () => {
    const w = mountColumn()
    w.findComponent(ChatMessages).vm.$emit('respond', PERMISSION, 'allow')
    w.findComponent(SessionStatusBar).vm.$emit('stop')
    await w.vm.$nextTick()

    expect(w.emitted('respond')).toHaveLength(1)
    expect(w.emitted('stop')).toHaveLength(1)
  })
})

describe('ChatColumn.vue — sessionBound 会话绑定门控', () => {
  it('未传 sessionBound(默认 true)时渲染全部区块,既有行为不变', () => {
    const w = mountColumn()
    expect(w.findComponent(ChatMessages).exists()).toBe(true)
    expect(w.findComponent(TaskPanel).exists()).toBe(true)
    expect(w.findComponent(SessionStatusBar).exists()).toBe(true)
    expect(w.findComponent(PendingQueue).exists()).toBe(true)
    expect(w.findComponent(MessageInput).exists()).toBe(true)
  })

  it('sessionBound=false 时不渲染任何旧会话派生的展示状态,只保留标题与首条输入框', () => {
    const w = mountColumn({
      sessionBound: false,
      // 塞入非空旧会话字段:若门控失效这些控件就会泄漏出来。
      vendor: 'anthropic',
      agentSwitch: {
        current: { id: 'a', displayName: 'A' },
        candidates: [{ id: 'b', displayName: 'B' }],
        currentUnavailable: false,
      },
      showMode: true,
      sourceLabel: 'intent',
      showShare: true,
    })
    expect(w.findComponent(ChatMessages).exists()).toBe(false)
    expect(w.findComponent(TaskPanel).exists()).toBe(false)
    expect(w.findComponent(SessionStatusBar).exists()).toBe(false)
    expect(w.findComponent(PendingQueue).exists()).toBe(false)
    // 标题栏保留标题文本与 action 槽,vendor 点 / agent 切换器 / 模式下拉 / 溯源 / 分享全隐藏。
    expect(w.findComponent(SessionTitleBar).exists()).toBe(true)
    expect(w.find('.session-title-text').text()).toBe('Review session')
    expect(w.find('[data-testid="session-vendor-dot"]').exists()).toBe(false)
    expect(w.find('[data-testid="session-vendor-label"]').exists()).toBe(false)
    expect(w.find('[data-testid="session-agent-switch"]').exists()).toBe(false)
    expect(w.find('.right-controls').exists()).toBe(false)
    expect(w.find('[data-testid="session-source-jump"]').exists()).toBe(false)
    expect(w.find('[data-testid="share-button"]').exists()).toBe(false)
    // 首条输入框保留(其 has-active-session 由调用方显式控制)。
    expect(w.findComponent(MessageInput).exists()).toBe(true)
  })

  it('sessionBound=false 时 composer 的 submit / enqueue 仍正常上抛', async () => {
    const w = mountColumn({ sessionBound: false })
    const input = w.findComponent(MessageInput)
    input.vm.$emit('submit', 'hello', [])
    input.vm.$emit('enqueue', 'later', [])
    await w.vm.$nextTick()

    expect(w.emitted('submit')).toEqual([['hello', []]])
    expect(w.emitted('enqueue')).toEqual([['later', []]])
  })

  it('sessionBound 与 readonly 正交:未绑定 + 只读时 composer 仍由只读门隐藏', () => {
    const w = mountColumn({ sessionBound: false, readonly: true })
    expect(w.findComponent(MessageInput).exists()).toBe(false)
    expect(w.findComponent(PendingQueue).exists()).toBe(false)
    expect(w.findComponent(SessionStatusBar).exists()).toBe(false)
  })
})
