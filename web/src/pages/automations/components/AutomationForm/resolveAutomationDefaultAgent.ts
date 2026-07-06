import type { AgentConfig } from '@ccc/shared/protocol'

/**
 * Resolve the agent that seeds the **new-automation form's** default vendor +
 * agent selection (AC-R25). This is a create-time, one-shot pick — NOT the
 * runtime `resolveAgent` router; an automation record stores its own concrete
 * `vendor`/`agentId` snapshot and runs on that.
 *
 * Follow chain: `automationAgentId → defaultAgentId → first enabled agent`.
 * Both ids are matched only against *enabled* agents (disabled ones never seed
 * the form). Returns `undefined` when no enabled agent exists, so the caller can
 * apply its own system fallback (vendor `claude`, empty agent) without crashing.
 */
export function resolveAutomationDefaultAgent(
  agents: AgentConfig[],
  automationAgentId: string,
  defaultAgentId: string,
): AgentConfig | undefined {
  const enabled = agents.filter((a) => a.enabled !== false)
  if (enabled.length === 0) return undefined
  const wanted = automationAgentId || defaultAgentId
  const matched = wanted ? enabled.find((a) => a.id === wanted) : undefined
  return matched ?? enabled[0]
}
