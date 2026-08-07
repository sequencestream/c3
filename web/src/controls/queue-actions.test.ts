/**
 * Queue control layer — the unpark round trip.
 *
 * Three things it must get right: the click sends exactly one `queue_control`
 * carrying the clicked intent, the server's refusal is VISIBLE (a `queue.*` error
 * reaches the global toast rather than the chat stream the queue page never
 * renders), and the page's park state only changes when the server's own
 * `queue_detail` says so — never optimistically on the click.
 */
import { describe, it, expect, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { ClientToServer, QueueDetail, QueueIntentDetail } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import { installQueueActions } from './queue-actions'
import { installMessageHandler } from './message-handler'
import { translateUiError } from '@/i18n/errors'

const WS = '/abs/proj-1'

function parkedItem(over: Partial<QueueIntentDetail> = {}): QueueIntentDetail {
  return {
    intentId: 'A',
    title: '意图 A',
    status: 'todo',
    priority: 'P1',
    blockedReason: 'blocked_parked',
    blockedDetail: '',
    nextWakeupAt: null,
    lastAction: 'park',
    lastDecidedAt: null,
    attemptCount: 3,
    backoffCount: 2,
    backoffUntil: 1_800_000_000_000,
    parked: true,
    parkReason: 'max_attempts_reached',
    parkDetail: '连续 3 次失败',
    forceSkipped: false,
    queuePosition: null,
    ...over,
  }
}

function detail(items: QueueIntentDetail[]): QueueDetail {
  return { workspaceId: WS, state: 'running', tickId: 't-2', nextWakeupAt: null, items }
}

function makeCtx(opts: { project?: string | null } = {}) {
  const send = vi.fn()
  const showToast = vi.fn()
  const add = vi.fn()
  const queueDetail = ref<Record<string, QueueDetail>>({})
  const intentsProject = ref<string | null>(opts.project === undefined ? WS : opts.project)
  const ctx = {
    client: {} as never,
    send,
    showToast,
    add,
    t: (key: string) => key,
    auth: { isAdmin: ref(true) },
    intentsProject,
    queueDetail,
    currentQueueDetail: computed(() =>
      intentsProject.value ? (queueDetail.value[intentsProject.value] ?? null) : null,
    ),
    queuePageOpen: ref(false),
    createPrProgress: ref(null),
    createIntentPending: ref(false),
    automationSaving: ref(false),
    automationEnabledSaving: ref(false),
    automationSettingBeforeSave: ref(null),
    // Delivery refs touched by the message-handler's error branch; a no-op here.
    activeDeliveryBranchInit: ref(null),
    activeDeliverySyncPhase: ref(null),
    activeDeliveryMainlineAhead: ref(null),
    activeDelivery: ref(null),
    activeDeliveryId: ref(null),
  } as unknown as AppCtx
  installQueueActions(ctx)
  installMessageHandler(ctx)
  return { ctx, send, showToast, add }
}

function sent(send: ReturnType<typeof vi.fn>): ClientToServer[] {
  return send.mock.calls.map((c) => c[0] as ClientToServer)
}

describe('queueControl — unpark 请求', () => {
  it('一次点击只发一条针对该 intentId 的 unpark', () => {
    const { ctx, send } = makeCtx()
    ctx.queueControl('unpark', 'A')

    expect(sent(send)).toEqual([
      { type: 'queue_control', workspaceId: WS, action: 'unpark', intentId: 'A' },
    ])
  })

  it('重复点击各自独立发出,由服务端逐条校验(客户端不去重、不预测)', () => {
    const { ctx, send } = makeCtx()
    ctx.queueControl('unpark', 'A')
    ctx.queueControl('unpark', 'A')

    expect(sent(send)).toHaveLength(2)
    expect(sent(send).every((m) => m.type === 'queue_control')).toBe(true)
  })

  it('没有选中工作区时不发请求', () => {
    const { ctx, send } = makeCtx({ project: null })
    ctx.queueControl('unpark', 'A')

    expect(send).not.toHaveBeenCalled()
  })
})

describe('queue_control 被拒绝 — 错误必须可见', () => {
  it('queue.notParked 走全局 toast,不是只落进队列页看不到的聊天流', () => {
    const { ctx, showToast, add } = makeCtx()
    ctx.handleMessage({ type: 'error', error: { code: 'queue.notParked' } })

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith(translateUiError({ code: 'queue.notParked' }))
    // 文案是本地化后的说明,不是原始错误码。
    expect(showToast.mock.calls[0][0]).not.toBe('queue.notParked')
    expect(add).not.toHaveBeenCalled()
  })

  it('其余队列控制错误码同样可见', () => {
    for (const code of ['queue.intentRequired', 'queue.overrideNotApplicable'] as const) {
      const { ctx, showToast } = makeCtx()
      ctx.handleMessage({ type: 'error', error: { code } })
      expect(showToast).toHaveBeenCalledTimes(1)
    }
  })

  it('非 queue 前缀的错误仍按既有通道走,不被这条分支吞掉', () => {
    const { ctx, showToast, add } = makeCtx()
    ctx.handleMessage({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: '/abs/gone' } },
    })

    expect(showToast).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('被拒绝后页面仍显示原来的 park 状态(没有假成功)', () => {
    const { ctx, showToast } = makeCtx()
    ctx.handleMessage({ type: 'queue_detail', detail: detail([parkedItem()]) })
    ctx.queueControl('unpark', 'A')
    ctx.handleMessage({ type: 'error', error: { code: 'queue.notParked' } })

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(ctx.currentQueueDetail.value?.items[0].parked).toBe(true)
    expect(ctx.currentQueueDetail.value?.items[0].parkReason).toBe('max_attempts_reached')
  })
})

describe('queue_detail 推送 — 解除成功后的唯一真相', () => {
  it('服务端回的新投影里该条不再 park,原因与退避一并清空', () => {
    const { ctx } = makeCtx()
    ctx.handleMessage({ type: 'queue_detail', detail: detail([parkedItem()]) })
    expect(ctx.currentQueueDetail.value?.items[0].parked).toBe(true)

    ctx.queueControl('unpark', 'A')
    ctx.handleMessage({
      type: 'queue_detail',
      detail: detail([
        parkedItem({
          parked: false,
          parkReason: null,
          parkDetail: null,
          attemptCount: 0,
          backoffUntil: null,
          blockedReason: 'blocked_dependency',
        }),
      ]),
    })

    const item = ctx.currentQueueDetail.value?.items[0]
    expect(item?.parked).toBe(false)
    expect(item?.parkReason).toBe(null)
    expect(item?.parkDetail).toBe(null)
    expect(item?.attemptCount).toBe(0)
    expect(item?.backoffUntil).toBe(null)
    // 解除 park ≠ 立刻开跑:仍未解决的硬闸门照旧挡着它。
    expect(item?.blockedReason).toBe('blocked_dependency')
  })
})
