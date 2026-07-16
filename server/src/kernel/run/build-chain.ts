/**
 * `buildAgentsToTry` — the pure degradation-chain builder (2026-06-06-006).
 *
 * The degradation chain is **vendor-homogeneous**: a fallback agent of a different
 * vendor than the session's current agent is **skipped**, not tried. Cross-vendor
 * degradation cannot carry context — a Claude session cannot `resume` into Codex
 * (the SDK errors; ADR-0011 / Phase-0 008), and the runClaude loop would otherwise
 * launch the wrong vendor's config under the Claude CLI. So same-vendor entries
 * stay (`sonnet → haiku` is fine — a fresh same-vendor session), and cross-vendor
 * entries are dropped and reported so the console can say so honestly ("无法承接
 * 上下文") rather than implying they were tried. Carrying context across vendors
 * would need the deferred **replay-seed path** (open a new target-vendor session
 * seeded with the canonical transcript as a prompt) — out of scope here.
 *
 * Pure: no IO/registry/SDK. The resolver and launch mapper are injected so the
 * builder is unit-tested directly (`build-chain.test.ts`).
 */
import type { AgentConfig, VendorId } from '@ccc/shared/protocol'
import type { RelayCandidate } from '../relay/contract.js'

/** One agent attempt the launcher runs (entry 0 = session agent, rest = chain). */
export interface AgentAttempt {
  agentId: string
  envOverrides?: Record<string, string>
  model?: string
  /** The relay candidate list for this attempt's agent/group (ADR-0029); the claude
   *  launch site binds it behind a per-run relay token. Absent ⇒ system mode. */
  relayCandidates?: RelayCandidate[]
}

/** A chain agent dropped for being a different vendor than the session agent. */
export interface SkippedAgent {
  agentId: string
  agentName: string
  vendor: VendorId
}

export interface BuiltChain {
  /** Entry 0 (the session agent) + same-vendor chain agents, deduped, in order. */
  agentsToTry: AgentAttempt[]
  /** Chain agents of a different vendor, dropped (context cannot be carried). */
  crossVendorSkipped: SkippedAgent[]
}

/**
 * Build the ordered attempt list from the session's first launch + the configured
 * degradation chain, keeping only same-vendor chain agents.
 *
 * @param firstLaunch  the resolved session agent (always attempt 0).
 * @param firstVendor  that agent's vendor — the homogeneity anchor.
 * @param chain        the configured chain of agent ids (already normalized to
 *                     known, enabled ids), or undefined for no degradation.
 * @param resolve      id → full {@link AgentConfig} (for vendor + display name).
 * @param launch       agent → launch overrides (env / model).
 */
export function buildAgentsToTry(
  firstLaunch: AgentAttempt,
  firstVendor: VendorId,
  chain: string[] | undefined,
  resolve: (id: string) => AgentConfig,
  launch: (agent: AgentConfig) => {
    envOverrides?: Record<string, string>
    model?: string
    relayCandidates?: RelayCandidate[]
  },
): BuiltChain {
  const agentsToTry: AgentAttempt[] = [firstLaunch]
  const crossVendorSkipped: SkippedAgent[] = []
  if (chain && chain.length > 0) {
    for (const id of chain) {
      const agent = resolve(id)
      // Skip the session agent (already attempt 0) and any duplicate.
      if (agent.id === firstLaunch.agentId) continue
      if (agentsToTry.some((a) => a.agentId === agent.id)) continue
      // Vendor-homogeneity: a different-vendor fallback cannot carry context.
      if (agent.vendor !== firstVendor) {
        crossVendorSkipped.push({
          agentId: agent.id,
          agentName: agent.displayName,
          vendor: agent.vendor,
        })
        continue
      }
      agentsToTry.push({ agentId: agent.id, ...launch(agent) })
    }
  }
  return { agentsToTry, crossVendorSkipped }
}
