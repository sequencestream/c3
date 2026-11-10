/**
 * chat-actions — 手动续接链路(`onContinue`)。副作用危险态的「继续」与崩溃态的
 * 「一键重试」共用这一条链路:两者都只是入口,落到 `onSubmit('continue')` 后
 * 发一条内容为 `continue` 的 `user_prompt`、乐观把会话切成 running,并清掉该会话
 * 的危险标志。没有新协议消息,也没有独立的重试状态。
 */
import { describe, it, expect, vi } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import type { PendingItem } from '@/lib/pending-queue'
import type { ClientToServer } from '@ccc/shared/protocol'
import { installChatActions } from './chat-actions'
import type { AppCtx } from './types'

const SID = 'sess-1'

function makeCtx(opts: { client?: boolean; activeSession?: string | null } = {}) {
  const send = vi.fn<(msg: ClientToServer) => void>()
  const activeSession = ref<string | null>(opts.activeSession === undefined ? SID : null)
  const sessionStatus = ref<Record<string, 'running' | 'idle'>>({})
  const activity = ref<import('@/lib/chat-types').RunActivity>({ phase: 'error', message: 'boom' })
  const clearSideEffectPending = vi.fn()
  const pendingQueues = ref<Record<string, PendingItem[]>>({})
  const currentQueue = computed(() =>
    activeSession.value ? (pendingQueues.value[activeSession.value] ?? []) : [],
  )
  const ctx = {
    send,
    client: opts.client === false ? null : {},
    activeSession,
    hasActiveSession: ref(activeSession.value !== null),
    sessionStatus,
    activity,
    mode: ref('default'),
    codexPolicy: ref(null),
    running: computed(() => sessionStatus.value[activeSession.value ?? ''] === 'running'),
    activeIsTeam: ref(false),
    pendingQueues,
    currentQueue,
    composer: ref(null),
    setQueue: vi.fn((sid: string, items: PendingItem[]) => {
      pendingQueues.value = { ...pendingQueues.value, [sid]: items }
    }),
    counters: { nextId: 1, nextQueueId: 1 },
    clearSideEffectPending,
    activeWorkspace: ref('/ws'),
  } as unknown as AppCtx
  installChatActions(ctx)
  return { ctx, send, sessionStatus, activity, clearSideEffectPending }
}

describe('chat-actions — onContinue(危险态「继续」/ 崩溃态一键重试的共用链路)', () => {
  it('发一条内容为 continue 的 user_prompt,且只发一条', () => {
    const { ctx, send } = makeCtx()
    ctx.onContinue()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ type: 'user_prompt', text: 'continue' })
  })

  it('乐观把当前会话切成 running,活动态从 error 转 thinking', () => {
    const { ctx, sessionStatus, activity } = makeCtx()
    expect(activity.value.phase).toBe('error')
    ctx.onContinue()
    expect(sessionStatus.value[SID]).toBe('running')
    expect(activity.value).toEqual({ phase: 'thinking' })
  })

  it('清掉该会话的副作用危险标志(新一轮开始)', () => {
    const { ctx, clearSideEffectPending } = makeCtx()
    ctx.onContinue()
    expect(clearSideEffectPending).toHaveBeenCalledWith(SID)
  })

  it('连接未就绪:不发送,也不做乐观状态变更', () => {
    const { ctx, send, sessionStatus, activity } = makeCtx({ client: false })
    ctx.onContinue()
    expect(send).not.toHaveBeenCalled()
    expect(sessionStatus.value[SID]).toBeUndefined()
    expect(activity.value.phase).toBe('error')
  })

  it('无活动会话:不发送', () => {
    const { ctx, send } = makeCtx({ activeSession: null })
    ctx.onContinue()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('chat-actions — queued message immediate send', () => {
  it('stops first, waits for idle, sends only the chosen message with images, then drains the rest next turn', async () => {
    const { ctx, send, sessionStatus } = makeCtx()
    sessionStatus.value[SID] = 'running'
    const images = [{ mediaType: 'image/png' as const, data: 'image-data' }]
    ctx.onEnqueue('first')
    ctx.onEnqueue('urgent', images)
    ctx.onEnqueue('last')
    const id = ctx.currentQueue.value[1].id
    ctx.onSendQueued(id)
    ctx.onSendQueued(id)
    await nextTick()
    expect(send.mock.calls.map(([msg]) => msg)).toEqual([{ type: 'stop_run' }])
    expect(ctx.currentQueue.value).toHaveLength(3)

    sessionStatus.value[SID] = 'idle'
    await nextTick()
    expect(send.mock.calls.map(([msg]) => msg)).toEqual([
      { type: 'stop_run' },
      { type: 'user_prompt', text: 'urgent', images },
    ])
    expect(ctx.currentQueue.value.map((item) => item.text)).toEqual(['first', 'last'])
    expect(sessionStatus.value[SID]).toBe('running')

    sessionStatus.value[SID] = 'idle'
    await nextTick()
    expect(send).toHaveBeenLastCalledWith({ type: 'user_prompt', text: 'first\n\nlast' })
    expect(ctx.currentQueue.value).toEqual([])
  })

  it('sends immediately without stopping when already idle', () => {
    const { ctx, send } = makeCtx()
    ctx.onEnqueue('next')
    ctx.onSendQueued(ctx.currentQueue.value[0].id)
    expect(send.mock.calls.map(([msg]) => msg)).toEqual([{ type: 'user_prompt', text: 'next' }])
  })

  it('puts a rejected follow-up back and retries it once the session is idle', async () => {
    const { ctx, send, sessionStatus } = makeCtx()
    sessionStatus.value[SID] = 'running'
    ctx.onEnqueue('urgent')
    ctx.onEnqueue('later')
    ctx.onSendQueued(ctx.currentQueue.value[0].id)
    await nextTick()
    sessionStatus.value[SID] = 'idle'
    await nextTick()
    expect(send.mock.calls.map(([msg]) => msg)).toEqual([
      { type: 'stop_run' },
      { type: 'user_prompt', text: 'urgent' },
    ])
    expect(ctx.currentQueue.value.map((item) => item.text)).toEqual(['later'])

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      expect(ctx.restoreRejectedPrompt('session.turnRunning')).toBe(true)
      expect(ctx.currentQueue.value.map((item) => item.text)).toEqual(['urgent', 'later'])
      expect(ctx.currentQueue.value[0]?.immediate).toBe(true)
      // Idle again during the backoff must not send a second time.
      sessionStatus.value[SID] = 'idle'
      await nextTick()
      expect(send.mock.calls.filter(([msg]) => msg.type === 'user_prompt')).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(send.mock.calls.at(-1)?.[0]).toEqual({ type: 'user_prompt', text: 'urgent' })
      expect(ctx.currentQueue.value.map((item) => item.text)).toEqual(['later'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an accepted follow-up from being restored by a later rejection', () => {
    const { ctx, sessionStatus } = makeCtx()
    sessionStatus.value[SID] = 'idle'
    ctx.onEnqueue('sent')
    ctx.onSendQueued(ctx.currentQueue.value[0].id)
    ctx.notePromptDelivered()
    expect(ctx.restoreRejectedPrompt('session.turnRunning')).toBe(false)
    expect(ctx.currentQueue.value).toEqual([])
    expect(ctx.restoreRejectedPrompt('session.notSelected')).toBe(false)
  })

  it('keeps the queue untouched when disconnected or the item was removed', () => {
    const { ctx, send } = makeCtx({ client: false })
    ctx.onEnqueue('keep')
    ctx.onSendQueued(ctx.currentQueue.value[0].id)
    expect(ctx.currentQueue.value).toEqual([{ id: 1, text: 'keep' }])
    expect(send).not.toHaveBeenCalled()
    const connected = makeCtx()
    connected.ctx.onSendQueued(99)
    expect(connected.send).not.toHaveBeenCalled()
  })
})
