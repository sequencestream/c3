/**
 * Static per-vendor capability ledger + the derived upper-layer gates
 * (2026-06-06-006 heterogeneous tolerance). SDK-free leaf: it imports only the
 * three pure {@link AdapterCapabilities} constants (themselves type-only imports),
 * so the run loop can ask "can this vendor do X?" **without constructing an
 * adapter** (which needs the host binary). The registry's "probe before construct"
 * gate is about *availability*; this map is about *ability* — orthogonal.
 */
import type { VendorId } from '@ccc/shared/protocol'
import type { AdapterCapabilities } from './types.js'
import { claudeCapabilities } from './claude/capabilities.js'
import { opencodeCapabilities } from './opencode/capabilities.js'
import { codexCapabilities } from './codex/capabilities.js'

/** Every vendor's capability ledger, keyed by {@link VendorId}. */
export const VENDOR_CAPABILITIES: Record<VendorId, AdapterCapabilities> = {
  claude: claudeCapabilities,
  opencode: opencodeCapabilities,
  codex: codexCapabilities,
}

/**
 * Whether a vendor may upgrade a session to a **persistent agent team**. The team
 * lead is the load-bearing constraint: it must (a) stay resident across turns and
 * receive pushed input, and (b) run in-process `TeamCreate` / `SendMessage`. Both
 * collapse to the `streamingPush` capability — the SDK control channel kept live
 * so the lead process outlives a `result` (ADR-0008 / AS-R14). Only Claude has it
 * (`streamingPush: true`); Codex closes stdin after dispatch and OpenCode is a
 * remote out-of-loop server, so neither can host a lead. So agent-teams are
 * **Claude-locked**, and a non-Claude session must never be marked `team`
 * (2026-06-06-006). A heterogeneous *teammate* (one-shot task dispatch, Codex as a
 * read-only advisor seat) is a documented later phase, not this gate.
 */
export function canFormTeam(vendor: VendorId): boolean {
  return VENDOR_CAPABILITIES[vendor].streamingPush
}
