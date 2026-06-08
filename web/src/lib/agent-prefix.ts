/*
 * agent-prefix.ts — 客户端推断「当前 session 真正在跑的 agent」展示名。
 *
 * 状态栏前缀需要回答「现在到底是哪个 agent 在跑」。服务端的降级顺序是
 * `[默认/绑定 agent, ...degradationChain 去重去自身]`(server.ts 的 agentsToTry),
 * 失败时 `agent_failed(agentId=X)` 表示 X 这一项失败、下一项接管。这里复刻同一
 * 有序表,只保留下标(链位),展示名由 settings 现读现解 —— 改名/换默认 agent 后
 * 前缀经 computed 自动刷新。per-session 绑定 agent 通过 resolveAgentIndex
 * 查找在降级链中的位置,让状态栏显示 session 实际绑定的 agent 名。
 */
import type { SystemSettings } from '@ccc/shared/protocol'

/**
 * 服务端尝试顺序的客户端复刻:默认 agent 在前,随后是 degradationChain 中去重、
 * 去掉默认 agent 自身的条目。只保留 `agents` 里真实存在的 id。空/无 settings → []。
 */
export function agentAttemptOrder(settings: SystemSettings | null): string[] {
  if (!settings) return []
  const known = new Set(settings.agents.map((a) => a.id))
  const order: string[] = []
  const push = (id: string): void => {
    if (id && known.has(id) && !order.includes(id)) order.push(id)
  }
  push(settings.defaultAgentId)
  for (const id of settings.degradationChain ?? []) push(id)
  return order
}

/**
 * 链位下标 → agent 展示名。下标越界向末项夹取(降到链尾就停在最后一个)。
 * order 为空或解析不到名字时返回 '',调用方据此不渲染前缀。
 */
export function agentNameAt(settings: SystemSettings | null, index: number): string {
  const order = agentAttemptOrder(settings)
  if (order.length === 0) return ''
  const clamped = Math.min(Math.max(index, 0), order.length - 1)
  const id = order[clamped]
  return settings?.agents.find((a) => a.id === id)?.displayName ?? ''
}

/**
 * 根据 agent id 在 agentAttemptOrder 中的位置返回下标。
 * 用于 session_selected 时查找 session 实际绑定 agent 的链位,
 * 替代直接写死 0(默认 agent)。
 * 在 order 中找不到 agentId 时返回 0(默认 agent),避免空显示。
 */
export function resolveAgentIndex(
  settings: SystemSettings | null,
  agentId: string | undefined,
): number {
  if (!agentId) return 0
  const order = agentAttemptOrder(settings)
  if (order.length === 0) return 0
  const pos = order.indexOf(agentId)
  return pos >= 0 ? pos : 0
}

/**
 * `agent_failed` 推进:失败 agent 的下一项接管,夹取到链尾。优先按 failedAgentId
 * 在链上的位置推进(对漏数/乱序更鲁棒);链上找不到该 id 时退回 currentIndex+1。
 */
export function advanceOnFailure(
  settings: SystemSettings | null,
  currentIndex: number,
  failedAgentId: string,
): number {
  const order = agentAttemptOrder(settings)
  if (order.length === 0) return 0
  const last = order.length - 1
  const failedPos = order.indexOf(failedAgentId)
  const base = failedPos >= 0 ? failedPos : currentIndex
  return Math.min(base + 1, last)
}
