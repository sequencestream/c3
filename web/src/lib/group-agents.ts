/*
 * group-agents.ts — 客户端派生「虚拟 group agent」(ADR-0029)。
 *
 * 服务端把每个非空 `group` 暴露为虚拟 agent `_c3_<group>`(相同 `(group, vendor)`
 * 的 enabled agent 按 order_seq 优先级构成一个可 failover 的候选集)。前端各 agent
 * 选择点需要把这些虚拟 agent 作为可选项列出;这里本地复刻服务端的枚举口径
 * (enabled + order_seq 排序 + 首个成员锁定组 vendor),避免协议改动。与
 * lib/agent-prefix.ts「本地复刻服务端降级链」同一模式。
 */
import type { AgentConfig, VendorId } from '@ccc/shared/protocol'
import { groupAgentRef, parseGroupAgentRef } from '@ccc/shared/protocol'

/** A virtual group agent: the reference id `_c3_<group>`, its group name (display),
 *  and the group's locked vendor (its first enabled member's vendor). */
export interface GroupAgent {
  id: string
  group: string
  vendor: VendorId
}

/**
 * The virtual group agents for a registry: for each distinct `(vendor, group)` among
 * ENABLED agents (scanned in order_seq order), one entry — mirroring the server's
 * `enumerateGroupAgents`. The group identity carries the vendor (ADR-0029), so
 * different vendors may reuse the same group name (each is a distinct group).
 */
export function listGroupAgents(agents: AgentConfig[]): GroupAgent[] {
  const sorted = [...agents].sort((a, b) => (a.order_seq ?? 0) - (b.order_seq ?? 0))
  const seen = new Map<string, GroupAgent>()
  for (const a of sorted) {
    if (a.enabled === false) continue
    const g = a.group?.trim()
    if (!g) continue
    const id = groupAgentRef(a.vendor, g)
    if (!seen.has(id)) seen.set(id, { id, group: g, vendor: a.vendor })
  }
  return [...seen.values()]
}

/** The virtual group agents whose locked vendor matches (vendor-scoped pickers). */
export function groupAgentsOfVendor(agents: AgentConfig[], vendor: VendorId): GroupAgent[] {
  return listGroupAgents(agents).filter((g) => g.vendor === vendor)
}

/**
 * Display label for an agent reference id: the prefixed ref `_c3_<group>` itself for
 * a group ref (so a group reads distinctly from a real agent), else the matching real
 * agent's `displayName`, else null (caller falls back).
 */
export function agentRefDisplayName(
  agents: AgentConfig[],
  ref: string | undefined | null,
): string | null {
  if (!ref) return null
  if (parseGroupAgentRef(ref)) return ref
  return agents.find((a) => a.id === ref)?.displayName ?? null
}
