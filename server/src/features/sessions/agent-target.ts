/**
 * The session-creation view of agent-role resolution — the one place every
 * "create a session for role X" path asks *which agent, and may I?*.
 *
 * The kernel resolves a role/reference to an {@link AgentTarget} (the routing ref
 * to persist + the representative member every display and launch parameter comes
 * from). This module adds the second half of "no usable member": a GROUP whose
 * vendor has no runtime on this machine cannot run either, and — like an empty
 * group — that is a configuration error the user must see, not something to route
 * around. Concrete (non-group) agents keep their existing behaviour: a missing
 * vendor runtime is surfaced by the session's own unavailability signal, never by
 * refusing to create the session.
 *
 * Callers use the result BEFORE any side effect (runtime, projection row, viewer
 * switch, pending link), so a refusal leaves nothing half-built.
 */
import type { AgentRole, AgentTargetResult } from '../../kernel/agent-config/index.js'
import {
  tryResolveAgentTarget,
  tryResolveRoleAgentTarget,
} from '../../kernel/agent-config/index.js'
import { availableVendorSet } from '../../kernel/agent/vendor-runtime.js'
import type { UiError } from '@ccc/shared/ui-codes.js'

/** Apply the group vendor-runtime gate on top of a kernel target result. */
function withVendorGate(result: AgentTargetResult): AgentTargetResult {
  if (!result.ok) return result
  const { target } = result
  if (!target.isGroup) return result
  return availableVendorSet().has(target.agent.vendor)
    ? result
    : { ok: false, groupRef: target.ref }
}

/**
 * The agent target a session created for `role` must bind — the group reference
 * (with its representative member) or the concrete agent. `ok: false` carries the
 * group at fault so the caller can name it in the error it reports.
 */
export function sessionAgentTargetForRole(role: AgentRole): AgentTargetResult {
  return withVendorGate(tryResolveRoleAgentTarget(role))
}

/**
 * The same gate for an explicitly picked reference (the new-session modal's agent
 * / group choice). `null` means "Auto" — follow the default role.
 */
export function sessionAgentTargetForRef(ref: string | null): AgentTargetResult {
  return withVendorGate(tryResolveAgentTarget(ref))
}

/** The structured error a refused creation reports (localized by the web). */
export function groupUnavailableError(groupRef: string): UiError {
  return { code: 'agent.groupUnavailable', params: { group: groupRef } }
}
