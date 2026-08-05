/**
 * chat-actions — 手动续接链路(`onContinue`)。副作用危险态的「继续」与崩溃态的
 * 「一键重试」共用这一条链路:两者都只是入口,落到 `onSubmit('continue')` 后
 * 发一条内容为 `continue` 的 `user_prompt`、乐观把会话切成 running,并清掉该会话
 * 的危险标志。没有新协议消息,也没有独立的重试状态。
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
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
  const ctx = {
    send,
    client: opts.client === false ? null : {},
    activeSession,
    hasActiveSession: ref(activeSession.value !== null),
    sessionStatus,
    activity,
    mode: ref('default'),
    codexPolicy: ref(null),
    running: ref(false),
    activeIsTeam: ref(false),
    currentQueue: ref([]),
    composer: ref(null),
    setQueue: vi.fn(),
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
