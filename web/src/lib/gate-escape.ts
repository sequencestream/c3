/*
 * gate-escape — 从「启动被闸门拦下」到「用户手里有什么出口」的纯映射。
 *
 * 服务端的拒绝只说明事实(哪个闸门、为什么),不说明补救方式;补救是人的决定,
 * 出口该长什么样是前端的事。这里把错误码翻成出口种类,好让弹窗与动作接线可以
 * 单测,不必拉起一个真实会话。
 *
 * 两类出口在性质上完全不同,绝不混为一谈:
 *
 *   - 依赖闸门是**建议**:它说的是「你依赖的产出多半不在你的 base 上」,后果是
 *     后续合并冲突或返工,而不是数据损坏。所以它有强制放行 —— 带风险说明的二次
 *     确认 + 审计。
 *   - worktree 基线不符是**数据安全**:重建会丢未提交的工作,合并会改写用户自己
 *     的分支。所以它没有强制放行,只有两个显式动作;有未提交改动时连重建都不给。
 */

/** 一次被拦下的启动,用户可选的出口。 */
export type GateEscape =
  /** 依赖闸门:可强制放行(需二次确认 + 风险说明,留审计)。 */
  | { kind: 'dependency'; intentId: string }
  /** 基线不符且 worktree 干净:重建 或 合入交付分支。 */
  | { kind: 'worktree-clean'; intentId: string }
  /** 基线不符且有未提交改动:只能合入;重建需用户先提交/暂存。 */
  | { kind: 'worktree-dirty'; intentId: string }
  /** 关联了多个交付:必须先选定本次开发针对哪个交付。 */
  | { kind: 'delivery-context'; intentId: string }

/** 依赖闸门的三种阻塞文案码 —— 三态各一,出口相同。 */
const DEPENDENCY_CODES = new Set([
  'intent.dependencyNotMerged',
  'intent.dependencyPrUnmergedInDelivery',
  'intent.dependencyDeliveryNotDelivered',
])

/**
 * 这次拒绝给用户留了什么出口;`null` 表示没有出口(普通错误,照旧只展示文案)。
 * `intentId` 为空(没有在飞的启动可归属)时一律返回 null:没有目标的出口按钮
 * 只会让人点了没反应。
 */
export function gateEscapeFor(code: string, intentId: string | null): GateEscape | null {
  if (!intentId) return null
  if (DEPENDENCY_CODES.has(code)) return { kind: 'dependency', intentId }
  if (code === 'intent.worktreeBaseMismatch') return { kind: 'worktree-clean', intentId }
  if (code === 'intent.worktreeBaseMismatchDirty') return { kind: 'worktree-dirty', intentId }
  if (code === 'intent.deliveryContextRequired') return { kind: 'delivery-context', intentId }
  return null
}
