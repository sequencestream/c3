import type { AgentConfig } from '@ccc/shared/protocol'
import { parseGroupAgentRef } from '@ccc/shared'

/**
 * Resolve the agent that seeds a **template's or the new-automation form's**
 * default vendor + agent selection. This is a create-time, one-shot pick — NOT the
 * runtime `resolveAgent` router; an automation record stores its own concrete
 * `vendor`/`agentId` snapshot and runs on that.
 *
 * The chain head (`roleRef`) is an **arbitrary role reference** — `automationAgentId`
 * for the new-automation form, or `reviewAgentId`/`fixAgentId` for the two PR-review
 * templates. Follow chain:
 *
 *   `roleRef → defaultAgentId → first enabled agent`.
 *
 * Each step matches only against *enabled* agents (disabled ones never seed). A
 * virtual group reference (`_c3_<vendor>_<group>`) at either the head or the
 * fallback is flattened to that group's first enabled member (the same enumeration
 * `group-agents.ts` uses), because an automation record is validated and dispatched
 * against a concrete agent. An empty or dangling reference falls through to the next
 * step. Returns `undefined` when no enabled agent exists, so the caller can apply its
 * own system fallback (vendor `claude`, empty agent) without crashing.
 */
export function resolveAutomationDefaultAgent(
  agents: AgentConfig[],
  roleRef: string,
  defaultAgentId: string,
): AgentConfig | undefined {
  const enabled = agents.filter((a) => a.enabled !== false)
  if (enabled.length === 0) return undefined
  return resolveRef(enabled, roleRef) ?? resolveRef(enabled, defaultAgentId) ?? enabled[0]
}

/** One follow-chain step: resolve a reference to a concrete enabled agent, flattening
 *  a virtual group reference to its first enabled member. Empty/dangling ⇒ undefined. */
function resolveRef(enabled: AgentConfig[], ref: string): AgentConfig | undefined {
  if (!ref) return undefined
  const group = parseGroupAgentRef(ref)
  if (group) {
    return enabled.find((a) => a.vendor === group.vendor && (a.group?.trim() ?? '') === group.group)
  }
  return enabled.find((a) => a.id === ref)
}
