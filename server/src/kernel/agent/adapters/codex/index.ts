/**
 * Codex vendor adapter (ADR-0011, Phase 0 probe 008 NO-GO, 2026-06-06-005) — c3's
 * read-only advisor seat. Assembled from its driver (launch-time policy + read-only
 * monitor + whole-turn abort), a no-op approval bridge (no per-tool approval point
 * exists), and a (currently empty) session store. The upper layer selects this by
 * `VendorId === 'codex'` and drives it through the neutral {@link VendorAdapter}
 * faces only.
 *
 * Like Claude (per-run CLI) and unlike OpenCode (supervised server), Codex needs no
 * supervisor — it spawns `codex exec` per run via the SDK — so it registers as a
 * no-arg factory in `adapters/registry.ts`.
 */
import type { VendorAdapter } from '../types.js'
import { codexCapabilities } from './capabilities.js'
import { CodexDriver, type CodexFactory } from './driver.js'
import { CodexApprovalBridge, type CodexApprovalOptions } from './approval.js'
import { CodexSessionStore } from './session-store.js'
import { createCodexSkillLoader } from './skill.js'
import type { CodexRelay } from './relay-contract.js'

export { codexCapabilities } from './capabilities.js'
export { createCodexSkillLoader } from './skill.js'
export { CodexDriver, gateToCodexPolicy, type CodexFactory, type CodexClient } from './driver.js'
export { CodexApprovalBridge, type CodexApprovalOptions } from './approval.js'
export { CodexSessionStore } from './session-store.js'
export { itemToBlock, itemToCanonical } from './translate.js'
export { CODEX_RELAY_PROVIDER, type CodexRelay, type RelayUpstream } from './relay-contract.js'

/**
 * Build the Codex {@link VendorAdapter}. Each call yields fresh instances. The
 * optional {@link CodexFactory} injects the SDK boundary (tests pass a fake event
 * stream); `approvalOpts` carries the inert MCP-fallback seam (Phase 0 §4); `relay`
 * is the in-process Responses→Chat relay (ADR-0014) — when present, a codex agent
 * with a custom Chat-Completions provider URL is driven through it.
 */
export function createCodexAdapter(
  createCodex?: CodexFactory,
  approvalOpts?: CodexApprovalOptions,
  relay?: CodexRelay,
): VendorAdapter {
  return {
    vendor: 'codex',
    capabilities: codexCapabilities,
    driver: new CodexDriver(createCodex, relay),
    approval: new CodexApprovalBridge(approvalOpts),
    sessions: new CodexSessionStore(),
    skill: createCodexSkillLoader(),
  }
}
