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
import { isGroupAgentRef, parseGroupAgentRef } from '@ccc/shared/protocol'

/**
 * 服务端尝试顺序的客户端复刻:链头是 session 绑定的 agent(`anchorAgentId`,缺省或
 * 不在 `agents` 中时退回 `settings.defaultAgentId`),随后是 degradationChain 中与链头
 * 【同 vendor】、去重、去链头自身的条目。只保留 `agents` 里真实存在的 id。
 * 空/无 settings、或解析不到链头 agent → []。
 *
 * 链头取【绑定 agent】而非写死默认 agent 是关键:server 的 `agentsToTry` 以 session
 * 实际运行的 agent 作 entry 0(build-chain.ts),codex session 绑定 codex agent 时,
 * 写死默认(claude)agent 会让状态栏错显默认名。vendor 过滤复刻 server 的 vendor 同质化
 * (跨 vendor 无法承接上下文,不进降级链),避免另一 vendor 的链 agent 冒充"下一项"。
 */
export function agentAttemptOrder(
  settings: SystemSettings | null,
  anchorAgentId?: string,
): string[] {
  if (!settings) return []
  // A group-bound session (`_c3_<vendor>_<group>`, ADR-0029) has no client-visible
  // per-member chain — the relay hides the failover — so the attempt order is just the
  // group ref itself (its display name is resolved in agentNameAt). Only when that
  // (vendor, group) still has an enabled member; otherwise fall through to the default.
  const anchorGroup = anchorAgentId ? parseGroupAgentRef(anchorAgentId) : null
  if (
    anchorGroup &&
    settings.agents.some(
      (a) =>
        a.enabled !== false &&
        a.vendor === anchorGroup.vendor &&
        (a.group?.trim() ?? '') === anchorGroup.group,
    )
  ) {
    return [anchorAgentId!]
  }
  const byId = new Map(settings.agents.map((a) => [a.id, a]))
  const headId = anchorAgentId && byId.has(anchorAgentId) ? anchorAgentId : settings.defaultAgentId
  const head = byId.get(headId)
  if (!head) return []
  const order: string[] = [head.id]
  for (const id of settings.degradationChain ?? []) {
    const a = byId.get(id)
    if (!a || a.vendor !== head.vendor || order.includes(a.id)) continue
    order.push(a.id)
  }
  return order
}

/**
 * 链位下标 → agent 展示名。`anchorAgentId` 锚定链头(session 绑定 agent)。下标越界
 * 向末项夹取(降到链尾就停在最后一个)。order 为空或解析不到名字时返回 '',
 * 调用方据此不渲染前缀。
 */
export function agentNameAt(
  settings: SystemSettings | null,
  anchorAgentId: string | undefined,
  index: number,
): string {
  const order = agentAttemptOrder(settings, anchorAgentId)
  if (order.length === 0) return ''
  const clamped = Math.min(Math.max(index, 0), order.length - 1)
  const id = order[clamped]
  // A group ref shows as its prefixed form `_c3_<group>` (the ref itself), not a
  // real agent — it is not in the agent list.
  if (isGroupAgentRef(id)) return id
  return settings?.agents.find((a) => a.id === id)?.displayName ?? ''
}

/**
 * 根据 agent id 在 anchorAgentId 锚定的 agentAttemptOrder 中的位置返回下标。
 * 用于 session_selected/started 时查找当前运行 agent 的链位。链头即绑定 agent,
 * 故绑定 agent 本身通常落在 0。在 order 中找不到 agentId 时返回 0(链头),避免空显示。
 */
export function resolveAgentIndex(
  settings: SystemSettings | null,
  anchorAgentId: string | undefined,
  agentId: string | undefined,
): number {
  if (!agentId) return 0
  const order = agentAttemptOrder(settings, anchorAgentId)
  if (order.length === 0) return 0
  const pos = order.indexOf(agentId)
  return pos >= 0 ? pos : 0
}

/**
 * `agent_failed` 推进:失败 agent 的下一项接管,夹取到链尾。`anchorAgentId` 锚定链头。
 * 优先按 failedAgentId 在链上的位置推进(对漏数/乱序更鲁棒);链上找不到该 id 时
 * 退回 currentIndex+1。
 */
export function advanceOnFailure(
  settings: SystemSettings | null,
  anchorAgentId: string | undefined,
  currentIndex: number,
  failedAgentId: string,
): number {
  const order = agentAttemptOrder(settings, anchorAgentId)
  if (order.length === 0) return 0
  const last = order.length - 1
  const failedPos = order.indexOf(failedAgentId)
  const base = failedPos >= 0 ? failedPos : currentIndex
  return Math.min(base + 1, last)
}
