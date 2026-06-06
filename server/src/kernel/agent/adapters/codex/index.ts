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

export { codexCapabilities } from './capabilities.js'
export { CodexDriver, gateToCodexPolicy, type CodexFactory, type CodexClient } from './driver.js'
export { CodexApprovalBridge, type CodexApprovalOptions } from './approval.js'
export { CodexSessionStore } from './session-store.js'
export { itemToBlock, itemToCanonical } from './translate.js'

/**
 * Build the Codex {@link VendorAdapter}. Each call yields fresh instances. The
 * optional {@link CodexFactory} injects the SDK boundary (tests pass a fake event
 * stream); `approvalOpts` carries the inert MCP-fallback seam (Phase 0 §4).
 */
export function createCodexAdapter(
  createCodex?: CodexFactory,
  approvalOpts?: CodexApprovalOptions,
): VendorAdapter {
  return {
    vendor: 'codex',
    capabilities: codexCapabilities,
    driver: new CodexDriver(createCodex),
    approval: new CodexApprovalBridge(approvalOpts),
    sessions: new CodexSessionStore(),
  }
}
