/**
 * Intent-side delivery entries — the explicit-parameter actions and the
 * 「当前意图独立交付」 chain.
 *
 * Everything the delivery page sends binds its OPEN delivery; the intent page
 * has none, so these variants must carry every id themselves and still put the
 * SAME wire messages on the socket (no new protocol surface exists for the
 * intent side). The standalone chain is three of those messages in a fixed
 * order — create, then link, then branch init — stitched together only by the
 * pending slot, which is also what stops a plain delivery-page create from
 * being mistaken for the chain's own reply.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, Delivery, ServerToClient } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import { installDeliveryActions } from './delivery-actions'
import { installMessageHandler } from './message-handler'
import {
  calendarDateToEpochMs,
  defaultDeliveryBranchName,
  epochMsToCalendarDate,
  localCalendarDate,
} from '@/lib/delivery-view'

const WS = '/abs/proj-1'

function fakeDelivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd-new',
    workspaceId: WS,
    title: 'Fix login',
    description: 'Login breaks on retry',
    status: 'planned',
    startDate: null,
    endDate: null,
    branchName: null,
    baseBranch: 'main',
    branchReady: false,
    integration: { merged: 0, total: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function makeCtx() {
  const send = vi.fn()
  const showToast = vi.fn()
  const pendingStandaloneDelivery = ref<{ workspaceId: string; intentId: string } | null>(null)
  const activeDeliveryBranchInit = ref<{ deliveryId: string; phase: string } | null>(null)
  const activeDelivery = ref<Delivery | null>(null)
  const activeDeliveryId = ref<string | null>(null)
  const ctx = {
    client: {} as never,
    send,
    showToast,
    add: vi.fn(),
    t: (key: string) => key,
    auth: { isAdmin: ref(true) },
    activeTab: ref('intents'),
    persistViewMode: vi.fn(),
    deliveriesProject: ref<string | null>(null),
    deliveries: ref({}),
    deliveriesNeedsAction: ref({}),
    activeDelivery,
    activeDeliveryId,
    activeDeliveryPlan: ref(null),
    activeDeliveryIntents: ref([]),
    activeDeliveryMainlineAhead: ref(null),
    activeDeliveryBranchAhead: ref(null),
    activeDeliverySyncPhase: ref(null),
    activeDeliveryPr: ref(null),
    activeDeliveryPrBusy: ref(false),
    autoSyncedDeliveryPrs: ref(new Set<string>()),
    activeDeliveryBranchInit,
    pendingStandaloneDelivery,
    // Refs the generic `error` branch walks past on its way to the toast.
    createPrProgress: ref(null),
    dispatchCreatePr: vi.fn(),
    showIntentActionError: vi.fn(),
    showIntentGateEscape: vi.fn(),
    createIntentPending: ref(false),
    automationSaving: ref(false),
    automationEnabledSaving: ref(false),
    automationSettingBeforeSave: ref(null),
    closeDevLaunch: vi.fn(),
    dispatchSpecLaunch: vi.fn(),
    devLaunch: ref(null),
    specLaunch: ref(null),
  } as unknown as AppCtx
  installDeliveryActions(ctx)
  installMessageHandler(ctx)
  return { ctx, send, showToast, pendingStandaloneDelivery, activeDeliveryBranchInit }
}

function sent(send: ReturnType<typeof vi.fn>): ClientToServer[] {
  return send.mock.calls.map((c) => c[0] as ClientToServer)
}

describe('意图侧显式参数动作', () => {
  it('link / unlink 发出与交付页同一条协议消息,只是 id 全部显式', () => {
    const { ctx, send } = makeCtx()
    // 交付页的 deliveriesProject / activeDeliveryId 都是空的:意图侧动作绝不能
    // 依赖它们,否则用户在意图页永远发不出关联。
    ctx.linkIntentDelivery(WS, 'd-1', 'i-1')
    ctx.unlinkIntentDelivery(WS, 'd-1', 'i-1')
    ctx.loadDeliveriesForLink(WS)

    expect(sent(send)).toEqual([
      { type: 'link_intent_to_delivery', workspaceId: WS, deliveryId: 'd-1', intentId: 'i-1' },
      { type: 'unlink_intent_from_delivery', workspaceId: WS, deliveryId: 'd-1', intentId: 'i-1' },
      { type: 'list_deliveries', workspaceId: WS },
    ])
  })

  it('显式参数的分支初始化同样先落 in-flight 状态,既有进度/错误处理才接得住', () => {
    const { ctx, send, activeDeliveryBranchInit } = makeCtx()
    ctx.initDeliveryBranchFor(WS, 'd-1', 'delivery/abc-x', 'create')

    expect(activeDeliveryBranchInit.value).toEqual({ deliveryId: 'd-1', phase: 'fetching' })
    expect(sent(send)).toEqual([
      {
        type: 'init_delivery_branch',
        workspaceId: WS,
        deliveryId: 'd-1',
        branchName: 'delivery/abc-x',
        mode: 'create',
      },
    ])
  })
})

describe('「当前意图独立交付」三步编排', () => {
  const REQUEST = {
    workspaceId: WS,
    intentId: 'i-1',
    title: 'Fix login',
    description: 'Login breaks on retry',
  }

  it('按 create → link → init 顺序发出,载荷取自意图本身', () => {
    const { ctx, send } = makeCtx()
    ctx.createStandaloneDelivery(REQUEST)

    // 第一步只有 create:新交付的 id 此刻还不存在,后两步无从谈起。
    expect(sent(send)).toHaveLength(1)

    ctx.handleMessage({
      type: 'create_delivery_result',
      workspaceId: WS,
      delivery: fakeDelivery({ id: 'd-new', title: 'Fix login' }),
      prMergeNotice: false,
    } as ServerToClient)

    const messages = sent(send)
    const day = calendarDateToEpochMs(localCalendarDate(new Date()))
    expect(messages[0]).toEqual({
      type: 'create_delivery',
      workspaceId: WS,
      title: 'Fix login',
      description: 'Login breaks on retry',
      startDate: day,
      endDate: day,
    })
    // create_delivery_result 的既有副作用(拉详情)保留,链式两步接在其后。
    expect(messages.map((m) => m.type)).toEqual([
      'create_delivery',
      'get_delivery_detail',
      'link_intent_to_delivery',
      'init_delivery_branch',
    ])
    expect(messages[2]).toEqual({
      type: 'link_intent_to_delivery',
      workspaceId: WS,
      deliveryId: 'd-new',
      intentId: 'i-1',
    })
    expect(messages[3]).toEqual({
      type: 'init_delivery_branch',
      workspaceId: WS,
      deliveryId: 'd-new',
      branchName: defaultDeliveryBranchName('d-new', 'Fix login'),
      mode: 'create',
    })
  })

  it('起止日期编码回本地当天,正时区下也不会落成前一天', () => {
    const { ctx, send } = makeCtx()
    ctx.createStandaloneDelivery(REQUEST)

    const create = sent(send)[0] as Extract<ClientToServer, { type: 'create_delivery' }>
    const today = localCalendarDate(new Date())
    expect(create.startDate).toBe(create.endDate)
    // wire 存的是「用户所选日历日的 UTC 零点」,详情页正是用这个逆函数渲染的:
    // 若这里写本地零点,UTC+8 会编码成前一天 16:00Z,页面上就变成「昨天」。
    expect(epochMsToCalendarDate(create.startDate)).toBe(today)
  })

  it('飞行期间再点无效,pending 槽同时是防双发守卫', () => {
    const { ctx, send } = makeCtx()
    ctx.createStandaloneDelivery(REQUEST)
    ctx.createStandaloneDelivery(REQUEST)

    expect(sent(send).filter((m) => m.type === 'create_delivery')).toHaveLength(1)
  })

  it('交付页自己建的交付不会被误接上关联与初始化', () => {
    const { ctx, send } = makeCtx()

    ctx.handleMessage({
      type: 'create_delivery_result',
      workspaceId: WS,
      delivery: fakeDelivery({ id: 'd-plain' }),
      prMergeNotice: false,
    } as ServerToClient)

    expect(sent(send).map((m) => m.type)).toEqual(['get_delivery_detail'])
  })

  it('链只消费一次:同一次 create 的重复回包不会再关联一遍', () => {
    const { ctx, send } = makeCtx()
    ctx.createStandaloneDelivery(REQUEST)
    const result = {
      type: 'create_delivery_result',
      workspaceId: WS,
      delivery: fakeDelivery({ id: 'd-new' }),
      prMergeNotice: false,
    } as ServerToClient

    ctx.handleMessage(result)
    ctx.handleMessage(result)

    expect(sent(send).filter((m) => m.type === 'link_intent_to_delivery')).toHaveLength(1)
    expect(sent(send).filter((m) => m.type === 'init_delivery_branch')).toHaveLength(1)
  })

  it('create 被拒时释放 pending,按钮不会永久卡住', () => {
    const { ctx, send, pendingStandaloneDelivery } = makeCtx()
    ctx.createStandaloneDelivery(REQUEST)

    ctx.handleMessage({
      type: 'error',
      error: { code: 'delivery.createFailed', params: { detail: 'boom' } },
    } as ServerToClient)

    expect(pendingStandaloneDelivery.value).toBeNull()
    // 释放后可以重来一次,而不是要求用户刷新页面。
    ctx.createStandaloneDelivery(REQUEST)
    expect(sent(send).filter((m) => m.type === 'create_delivery')).toHaveLength(2)
  })
})

describe('openDeliveries — git-branch-mode fetch + cross-delivery clearing (根因修复)', () => {
  it('re-fetches the workspace setting and clears the previous delivery PR + ahead values', () => {
    const { ctx, send } = makeCtx()
    // A previous delivery's facts must not survive the switch to a new workspace.
    ctx.activeDeliveryPr.value = {
      deliveryId: 'd-old',
      forge: null,
      repo: null,
      number: '7',
      url: null,
      headBranch: 'delivery/d-old',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'merged',
      blockedReason: null,
      conflictFiles: [],
      createdAt: 1,
      updatedAt: 1,
    }
    ctx.activeDeliveryMainlineAhead.value = 3
    ctx.activeDeliveryBranchAhead.value = 5

    ctx.openDeliveries(WS)

    // The merge block gates on git-branch mode, which is a stored setting the
    // server resolves (worktree default). A stale `current-branch` fallback would
    // hide the merge block — so the setting is re-fetched on every entry.
    expect(sent(send).map((m) => m.type)).toEqual([
      'load_workspace_setting',
      'list_deliveries',
      'list_intents',
    ])
    expect(sent(send)[0]).toMatchObject({ type: 'load_workspace_setting', workspaceId: WS })
    expect(ctx.activeDeliveryPr.value).toBeNull()
    expect(ctx.activeDeliveryMainlineAhead.value).toBeNull()
    expect(ctx.activeDeliveryBranchAhead.value).toBeNull()
  })

  it('clears the ahead values when opening a different delivery', () => {
    const { ctx, send } = makeCtx()
    ctx.activeDeliveryId.value = 'd-old'
    ctx.activeDeliveryMainlineAhead.value = 3
    ctx.activeDeliveryBranchAhead.value = 5
    ctx.activeDeliveryPr.value = {
      deliveryId: 'd-old',
      forge: null,
      repo: null,
      number: '7',
      url: null,
      headBranch: 'delivery/d-old',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'merged',
      blockedReason: null,
      conflictFiles: [],
      createdAt: 1,
      updatedAt: 1,
    }

    ctx.openDelivery('d2')

    expect(sent(send).filter((m) => m.type === 'get_delivery_detail')).toHaveLength(1)
    expect(ctx.activeDeliveryPr.value).toBeNull()
    expect(ctx.activeDeliveryMainlineAhead.value).toBeNull()
    expect(ctx.activeDeliveryBranchAhead.value).toBeNull()
  })
})
