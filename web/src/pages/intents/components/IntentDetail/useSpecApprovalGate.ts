import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue'
import type { Intent } from '@ccc/shared/protocol'

// 主操作按钮四态机的三种动作(只对 todo 意图渲染)。
export type MainAction = 'startDev' | 'writeSpec' | 'approveSpec'

// 防误审门:记录每个意图在本次会话内点击「编写 Spec」的时刻(毫秒)。
// 故意放在模块作用域而非组件实例,使组件重挂载 / 重选意图后 10 秒窗口仍存活,
// 避免「重新进入页面或状态刷新」绕过延迟展示约束。条目只增不减(规模极小)。
const writeSpecTriggeredAt = new Map<string, number>()

// 点「编写 Spec」后约 1 秒自动切到 spec session Tab。
const SWITCH_SPEC_TAB_MS = 1000
// 「审核 Spec」状态主按钮从编写触发起延迟展示的窗口。
const APPROVE_GATE_MS = 10000

// 仅供单测重置模块级门状态,隔离用例之间的污染;生产代码不调用。
export function resetWriteSpecGuards(): void {
  writeSpecTriggeredAt.clear()
}

/**
 * 「编写 Spec 后延迟切 Tab」与 10 秒审批保护——Tab 与动作之间的跨域协调组合逻辑。
 * 只暴露声明式的 approveGateBlocked 与两个动作方法;切 Tab 通过注入的回调交回容器,
 * 定时器在意图切换和卸载时清理,不允许旧意图的回填或定时器抢占当前 Tab。
 */
export function useSpecApprovalGate(opts: {
  intent: () => Intent | null
  mainAction: ComputedRef<MainAction>
  onSwitchToSpecSession: () => void
}) {
  const { intent, mainAction, onSwitchToSpecSession } = opts

  // gateTick 仅作 approveGateBlocked 的响应式触发源:到点的定时器自增它,强制重算。
  const gateTick = ref(0)
  let approveGateTimer: ReturnType<typeof setTimeout> | null = null
  let switchSpecTabTimer: ReturnType<typeof setTimeout> | null = null

  // 当前审批动作处于 approveSpec 态、且本会话点过该意图的「编写 Spec」、且距触发不足
  // 10 秒时为 true → spec tab 内的真正批准入口不可见。不依赖 specPath 出现先后:
  // 本会话未点编写的意图不武装门,批准入口照常立即可见。
  const approveGateBlocked = computed<boolean>(() => {
    void gateTick.value
    const r = intent()
    if (!r || mainAction.value !== 'approveSpec') return false
    const at = writeSpecTriggeredAt.get(r.id)
    if (at === undefined) return false
    return Date.now() - at < APPROVE_GATE_MS
  })

  function clearApproveGateTimer(): void {
    if (approveGateTimer !== null) {
      clearTimeout(approveGateTimer)
      approveGateTimer = null
    }
  }

  function clearSwitchSpecTabTimer(): void {
    if (switchSpecTabTimer !== null) {
      clearTimeout(switchSpecTabTimer)
      switchSpecTabTimer = null
    }
  }

  // 为当前意图的防误审门排程一个「剩余时间」定时器,到点放行(自增 gateTick 触发重算)。
  function armApproveGate(): void {
    clearApproveGateTimer()
    const r = intent()
    if (!r) return
    const at = writeSpecTriggeredAt.get(r.id)
    if (at === undefined) return
    const remaining = APPROVE_GATE_MS - (Date.now() - at)
    if (remaining <= 0) return
    approveGateTimer = setTimeout(() => {
      approveGateTimer = null
      gateTick.value++
    }, remaining)
  }

  // 点「编写 Spec」:武装防误审门(以触发时刻锚定),并约 1 秒后自动切到 spec session Tab。
  // 仅当触发时的意图仍是当前选中意图时才切,用户已切走则不抢回。
  function triggerWriteSpec(intentId: string): void {
    writeSpecTriggeredAt.set(intentId, Date.now())
    armApproveGate()
    clearSwitchSpecTabTimer()
    switchSpecTabTimer = setTimeout(() => {
      switchSpecTabTimer = null
      if (intent()?.id === intentId) onSwitchToSpecSession()
    }, SWITCH_SPEC_TAB_MS)
  }

  // 意图切换或 specPath 回填(mainAction 变化)时重排门定时器;immediate 覆盖挂载/重挂载。
  watch(
    () => [intent()?.id, mainAction.value] as const,
    () => {
      armApproveGate()
    },
    { immediate: true },
  )

  // 切走意图:取消挂起的自动切 Tab,避免切到别的意图后误切。
  watch(
    () => intent()?.id,
    () => {
      clearSwitchSpecTabTimer()
    },
  )

  onBeforeUnmount(() => {
    clearApproveGateTimer()
    clearSwitchSpecTabTimer()
  })

  return { approveGateBlocked, triggerWriteSpec }
}
