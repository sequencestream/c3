/**
 * Agent configuration helpers shared by the server registry and the web console:
 * the virtual group-agent reference encoding and the default-agent fallback rule.
 * The types and constants themselves stay in the wire contract (`protocol.ts`);
 * this module holds the executable rules both ends must apply identically.
 */
import type { AgentConfig, VendorId } from './protocol.js'
import { GROUP_AGENT_PREFIX, SYSTEM_AGENT_ID, VENDOR_IDS } from './protocol.js'

/**
 * The virtual group-agent reference id for a `(vendor, group)` — `_c3_<vendor>_<group>`.
 * Encoding the vendor makes the group identity unambiguous, so DIFFERENT vendors may
 * reuse the SAME group name (each `(vendor, group)` is its own group / its own virtual
 * agent). Example: `('claude', 'fast')` → `_c3_claude_fast`.
 */
export function groupAgentRef(vendor: VendorId, group: string): string {
  return `${GROUP_AGENT_PREFIX}${vendor}_${group}`
}

/**
 * Parse a virtual group-agent id into its `(vendor, group)`, or null when it is not
 * one. The vendor is matched against the closed {@link VENDOR_IDS} set (so the group
 * name may itself contain underscores — everything after `_c3_<vendor>_` is the group).
 */
export function parseGroupAgentRef(id: string): { vendor: VendorId; group: string } | null {
  if (!id.startsWith(GROUP_AGENT_PREFIX)) return null
  const rest = id.slice(GROUP_AGENT_PREFIX.length)
  for (const vendor of VENDOR_IDS) {
    const marker = `${vendor}_`
    if (rest.startsWith(marker) && rest.length > marker.length) {
      return { vendor, group: rest.slice(marker.length) }
    }
  }
  return null
}

/** Whether an agent reference id is a virtual group agent (`_c3_<vendor>_<group>`). */
export function isGroupAgentRef(id: string): boolean {
  return parseGroupAgentRef(id) !== null
}

/**
 * Resolve the effective `defaultAgentId` for an agent registry, applying the
 * **"fall through to the next enabled agent"** rule. The chosen id is meant to be
 * **persisted** (rewrite-on-store semantics, not a runtime-only resolution) — both
 * the web SettingsPanel (on disabling/removing an agent) and the server `normalize`
 * (on every save) call this so a disabled default never silently degrades to the
 * synthesized system fallback at launch time.
 *
 * `agents` must be in the user-controlled order (`order_seq` ascending; the
 * server passes the canonicalized registry, the console passes its draft array
 * whose order already is the visual order). Rule:
 *  1. the current default still present **and** enabled ⇒ keep it;
 *  2. otherwise the **next enabled** agent after its position (scanning forward),
 *     wrapping to the first enabled agent overall when nothing follows or the
 *     current default was removed;
 *  3. no enabled agent at all ⇒ {@link SYSTEM_AGENT_ID} (the id `resolveAgent`
 *     synthesizes a fallback for — a session is never locked out).
 *
 * An agent counts as enabled unless `enabled === false` (back-compat with
 * configs predating the field).
 */
export function resolveDefaultAgentId(agents: AgentConfig[], currentDefaultId: string): string {
  const isEnabled = (a: AgentConfig): boolean => a.enabled !== false
  // A virtual group reference (`_c3_<vendor>_<group>`) stays selected as long as that
  // (vendor, group) still has an enabled member; an emptied group falls through like a
  // removed agent. Group refs are not in `agents` (they are virtual), so this must
  // precede the by-id lookup below or a valid group pick would be reset.
  const ref = parseGroupAgentRef(currentDefaultId)
  if (ref) {
    if (
      agents.some(
        (a) => isEnabled(a) && a.vendor === ref.vendor && (a.group?.trim() ?? '') === ref.group,
      )
    ) {
      return currentDefaultId
    }
    const firstEnabled = agents.find(isEnabled)
    return firstEnabled ? firstEnabled.id : SYSTEM_AGENT_ID
  }
  const current = agents.find((a) => a.id === currentDefaultId)
  if (current && isEnabled(current)) return currentDefaultId
  const idx = agents.findIndex((a) => a.id === currentDefaultId)
  for (let k = idx + 1; idx >= 0 && k < agents.length; k++) {
    if (isEnabled(agents[k])) return agents[k].id
  }
  const firstEnabled = agents.find(isEnabled)
  return firstEnabled ? firstEnabled.id : SYSTEM_AGENT_ID
}
