/**
 * One-click agent bootstrap for the Agent settings tab.
 *
 * A fresh install has no agent registry, and the Agent tab that opens on cold
 * start is a blank form: it asks the user to understand `vendor × configMode ×
 * displayName` before they have ever run a session. Yet the server already knows
 * which vendors can run here — that is exactly what `vendorRuntimeStatuses()`
 * answers for the runtime diagnostics. This turns that answer into configuration:
 * one `configMode: 'system'` agent per runnable vendor, persisted immediately.
 *
 * Deliberately narrow. It only ever creates `system`-mode agents (a `custom` one
 * needs a provider triple nobody can infer), it never edits or removes an
 * existing agent, and it treats runtime availability — not login state — as the
 * bar: "CLI installed, not yet logged in" is the common cold-start position, and
 * a stricter probe would lock exactly those users out. An unauthenticated vendor
 * surfaces its auth error at run time, where the existing vendor-auth flow
 * already handles it.
 */
import { VENDOR_IDS } from '@ccc/shared/protocol'
import type { AgentConfig, SystemSettings, VendorId } from '@ccc/shared/protocol'
import { systemAgentFor } from '../../kernel/agent-config/normalize.js'
import { availableVendorSet } from '../../kernel/agent/vendor-runtime.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import type { Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'
import { settingsFrame } from './index.js'

/**
 * The `displayName` a freshly bootstrapped agent is seeded with — the vendor's
 * product name, so the row reads as what it launches instead of "Agent 1".
 *
 * Persisted DATA, not UI copy: it lands in the settings store, travels to every
 * agent picker as-is and is the user's to rename afterwards. That is why it is a
 * const map here rather than an i18n key — a translated name would change what is
 * already stored the moment someone switched languages.
 */
const VENDOR_SEED_NAME: Record<VendorId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

/**
 * Whether `vendor` already has an agent that uses the vendor CLI's own config.
 *
 * This is the idempotency test, and it counts the SYNTHESIZED FALLBACK too: that
 * record is a real, launchable `claude` + `system` agent, so creating a second
 * one would leave the user with two identical claude rows the first time they
 * clicked. Skipping it is what makes a repeated click a no-op.
 */
function hasSystemAgent(agents: readonly AgentConfig[], vendor: VendorId): boolean {
  return agents.some((a) => a.vendor === vendor && a.configMode === 'system')
}

/**
 * The agents a bootstrap would add to `settings`, given the vendors that can run.
 *
 * Pure — it neither probes nor persists — so the decision (which vendors are
 * covered, what each seeded agent looks like, what the ids are) is testable
 * without a filesystem or a CLI on PATH. Walks {@link VENDOR_IDS} rather than the
 * available set so the result is in canonical vendor order regardless of probe
 * iteration order.
 *
 * `mintedAt` + a counter is the same id rule the console and the server
 * `normalize` already use: purely numeric, reading as its creation time, never
 * carrying a placeholder word like `new` or `copy`.
 */
export function planAutoConfiguredAgents(
  settings: SystemSettings,
  available: ReadonlySet<VendorId>,
  mintedAt: number,
): AgentConfig[] {
  const taken = new Set(settings.agents.map((a) => a.id))
  const created: AgentConfig[] = []
  let seq = 0
  const mintId = (): string => {
    let id = `${mintedAt}-${seq++}`
    while (taken.has(id)) id = `${mintedAt}-${seq++}`
    taken.add(id)
    return id
  }
  for (const vendor of VENDOR_IDS) {
    if (!available.has(vendor)) continue
    if (hasSystemAgent(settings.agents, vendor)) continue
    created.push(systemAgentFor(vendor, { id: mintId(), displayName: VENDOR_SEED_NAME[vendor] }))
  }
  return created
}

/**
 * Probe, create and persist in one step — no draft, no second confirmation.
 *
 * The new agents are APPENDED, so the existing order (and the pinned synthesized
 * fallback) is untouched; `saveSettings` then runs the ordinary normalize pass,
 * which stamps `order_seq`, validates each config against its vendor arm and
 * re-resolves `defaultAgentId` through the usual fall-through. Nothing here
 * decides the default itself — routing that choice through the same rule every
 * other save uses is what keeps the two from drifting.
 *
 * Both frames are sent even when nothing was created: the result frame is what
 * lets the console say WHY (no runnable vendor vs. already covered) instead of
 * silently doing nothing, and the `settings` echo keeps every settings consumer
 * on the one message it already reads.
 */
export const autoConfigureAgentsHandler: Handler<'auto_configure_agents'> = (_ctx, conn) => {
  // System configuration is admin-only — this writes agents, so
  // it sits behind the same gate as `save_settings`.
  if (!requireAdmin(conn)) return
  const available = availableVendorSet()
  const current = loadSettings()
  const created = planAutoConfiguredAgents(current, available, Date.now())
  const settings =
    created.length > 0
      ? saveSettings({ ...current, agents: [...current.agents, ...created] })
      : current
  conn.send({
    type: 'auto_configure_agents_result',
    created: created.length,
    availableVendors: available.size,
    vendors: created.map((a) => a.vendor),
  })
  conn.send(settingsFrame(settings))
}
