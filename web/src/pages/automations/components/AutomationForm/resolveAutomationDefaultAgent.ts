import type { AgentConfig } from '@ccc/shared/protocol'
import { parseGroupAgentRef } from '@ccc/shared'

/**
 * Resolve the agent that seeds a **template's or the new-automation form's**
 * default vendor + agent selection. This is a create-time, one-shot pick — NOT the
 * runtime `resolveAgent` router; an automation record stores its own concrete
 * `vendor`/`agentId` snapshot and runs on that.
 *
 * `candidateRefs` is the **full scoped candidate chain, in priority order** — the
 * shape {@link scopedSeedRefs} builds for every caller: the role's own system field,
 * the workspace's same-named override, the two default levels, one role field at the
 * head. The workspace links are NOT pre-folded here: the callers pass each committed
 * value separately so a workspace override can win over the system default without
 * ever being snapshotted into it.
 *
 * Each step matches only against *enabled* agents (disabled ones never seed). A
 * virtual group reference (`_c3_<vendor>_<group>`) at any link is flattened to that
 * group's first enabled member (the same enumeration `group-agents.ts` uses), because
 * an automation record is validated and dispatched against a concrete agent. An empty
 * or dangling reference falls through to the next link; once every configured link is
 * exhausted the chain ends on the first enabled agent. Returns `undefined` when no
 * enabled agent exists, so the caller can apply its own system fallback (vendor
 * `claude`, empty agent) without crashing.
 */
export function resolveAutomationDefaultAgent(
  agents: AgentConfig[],
  ...candidateRefs: string[]
): AgentConfig | undefined {
  const enabled = agents.filter((a) => a.enabled !== false)
  if (enabled.length === 0) return undefined
  for (const ref of candidateRefs) {
    const hit = resolveRef(enabled, ref)
    if (hit) return hit
  }
  return enabled[0]
}

/**
 * The scoped candidate chain of ONE role, folded into the order the runtime resolver
 * uses: a workspace that **explicitly configured** a default agent moves its
 * whole workspace layer ahead of the system role field — `workspace role override →
 * workspace defaultAgentId → system role field → system defaultAgentId` — while a
 * workspace that **inherits** keeps the system role field first. A blank workspace
 * default is the "inherit" sentinel (the key is omitted on the wire, never snapshotted
 * to the system value), so an unset workspace keeps the original order exactly.
 *
 * Exported so the create form and the template paths derive it from ONE rule: the
 * agent a form pre-selects is then the agent a launch would resolve, in a workspace
 * default agent's own workspace, instead of the system value that workspace overrode.
 */
export function scopedSeedRefs(input: {
  /** The role's own system-level field, e.g. `settings.automationAgentId`. */
  systemRoleRef?: string
  /** The workspace's same-named role override, when the role has one. */
  workspaceRoleRef?: string
  /** The workspace's own `defaultAgentId` — the switch for the order below. */
  workspaceDefaultAgentId?: string
  systemDefaultAgentId?: string
}): string[] {
  const systemRole = input.systemRoleRef ?? ''
  const workspaceRole = input.workspaceRoleRef ?? ''
  const workspaceDefault = input.workspaceDefaultAgentId ?? ''
  const systemDefault = input.systemDefaultAgentId ?? ''
  return workspaceDefault.trim()
    ? [workspaceRole, workspaceDefault, systemRole, systemDefault]
    : [systemRole, workspaceRole, workspaceDefault, systemDefault]
}

/** One follow-chain step: resolve a reference to a concrete enabled agent, flattening
 *  a virtual group reference to its first enabled member. Empty/dangling ⇒ undefined. */
function resolveRef(enabled: AgentConfig[], ref: string): AgentConfig | undefined {
  const id = ref?.trim() ?? ''
  if (!id) return undefined
  const group = parseGroupAgentRef(id)
  if (group) {
    return enabled.find((a) => a.vendor === group.vendor && (a.group?.trim() ?? '') === group.group)
  }
  return enabled.find((a) => a.id === id)
}
