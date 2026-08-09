import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue'
import type { Intent } from '@ccc/shared/protocol'

// 主操作按钮四态机的三种动作(只对 todo 意图渲染)。
export type MainAction = 'startDev' | 'writeSpec' | 'approveSpec'

// 防误审门:记录每个意图在本次会话内点击「编写 Spec」的时刻(毫秒)。
// 故意放在模块作用域而非组件实例,使组件重挂载 / 重选意图后 10 秒窗口仍存活,
// 避免「重新进入页面或状态刷新」绕过延迟展示约束。条目只增不减(规模极小)。
const writeSpecTriggeredAt = new Map<string, number>()

// 「审核 Spec」状态主按钮从编写触发起延迟展示的窗口。
const APPROVE_GATE_MS = 10000

// 仅供单测重置模块级门状态,隔离用例之间的污染;生产代码不调用。
export function resetWriteSpecGuards(): void {
  writeSpecTriggeredAt.clear()
}

/**
 * 「编写 Spec」防误审门——只负责 10 秒审批保护这一件事。
 * 只暴露声明式的 approveGateBlocked 与触发方法;定时器在意图切换和卸载时清理。
 * 编写后切到规范会话 Tab 由 useIntentDetailTabs 以 specSessionId 回填为条件驱动,
 * 不在这里用固定延时兜底:会话创建是异步且可失败的,定时到点时新会话可能还不存在。
 */
export function useSpecApprovalGate(opts: {
  intent: () => Intent | null
  mainAction: ComputedRef<MainAction>
}) {
  const { intent, mainAction } = opts

  // gateTick 仅作 approveGateBlocked 的响应式触发源:到点的定时器自增它,强制重算。
  const gateTick = ref(0)
  let approveGateTimer: ReturnType<typeof setTimeout> | null = null

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

  // 点「编写 Spec」:以触发时刻锚定并武装防误审门。
  function triggerWriteSpec(intentId: string): void {
    writeSpecTriggeredAt.set(intentId, Date.now())
    armApproveGate()
  }

  // 意图切换或 specPath 回填(mainAction 变化)时重排门定时器;immediate 覆盖挂载/重挂载。
  watch(
    () => [intent()?.id, mainAction.value] as const,
    () => {
      armApproveGate()
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    clearApproveGateTimer()
  })

  return { approveGateBlocked, triggerWriteSpec }
}
