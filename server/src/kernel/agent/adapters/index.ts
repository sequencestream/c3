/**
 * `kernel/agent/adapters/` barrel — the vendor-neutral Agent abstraction
 * (ADR-0011). Re-exports the neutral interfaces (the three-piece driver /
 * approval / session-store, the permission policy grid, the capability ledger,
 * the canonical message model) and the Claude reference adapter. New vendors add
 * a sibling `adapters/<vendor>/` and surface their `VendorAdapter` here.
 */
export type {
  VendorId,
  CanonicalRole,
  CanonicalMessage,
  CanonicalBlock,
  CanonicalToolResult,
  ActionMode,
  ToolGate,
  NeutralMode,
  ModeToken,
  VendorModeDescriptor,
  VendorModeCatalog,
  PolicyVerdict,
  PolicyContext,
  PermissionPolicy,
  AdapterCapability,
  AdapterCapabilities,
  DriverStartOptions,
  AgentDriver,
  AgentRun,
  ApprovalBridge,
  ApprovalHandler,
  ApprovalRequest,
  ApprovalDecision,
  Disposer,
  SessionSummary,
  SessionListOptions,
  SessionStore,
  TaskStatus,
  TaskData,
  TaskStore,
  VendorAdapter,
} from './types.js'

export { createClaudeAdapter } from './claude/index.js'
export { upsertBlock, CanonicalAccumulator } from './canonical-accumulator.js'

// ---------------------------------------------------------------------------
// Per-vendor mode catalogs (ADR-0011, 2026-06-07-012)
// ---------------------------------------------------------------------------

export { tokenToGrid, gridToToken, isKnownToken } from './mode-catalog.js'

import type { VendorId, VendorModeCatalog } from './types.js'
import { claudeModeCatalog } from './claude/modes.js'
import { codexModeCatalog } from './codex/modes.js'
import { opencodeModeCatalog } from './opencode/modes.js'

/**
 * Every vendor's {@link VendorModeCatalog}, keyed by {@link VendorId}. The
 * `Record<VendorId, …>` type is the compile-time drift-pin: adding a vendor to the
 * union without registering its catalog here (or vice-versa) stops type-checking.
 * The kernel resolves a session's stored {@link ModeToken} → neutral grid through
 * `MODE_CATALOGS[vendor]`; the settings handler ships the whole record to the web
 * on `settings.vendorModes` for the per-vendor mode picker.
 */
export const MODE_CATALOGS: Record<VendorId, VendorModeCatalog> = {
  claude: claudeModeCatalog,
  codex: codexModeCatalog,
  opencode: opencodeModeCatalog,
}
