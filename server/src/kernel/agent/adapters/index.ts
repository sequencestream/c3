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
export { createCursorAdapter } from './cursor/index.js'
export { upsertBlock, CanonicalAccumulator } from './canonical-accumulator.js'

// ---------------------------------------------------------------------------
// Per-vendor mode catalogs (ADR-0011, 2026-06-07-012)
// ---------------------------------------------------------------------------

export { tokenToGrid, gridToToken, isKnownToken } from './mode-catalog.js'

import type { VendorRuntimeOrigin } from '@ccc/shared/protocol'
import type { VendorId, VendorModeCatalog } from './types.js'
import { claudeModeCatalog } from './claude/modes.js'
import { codexModeCatalog } from './codex/modes.js'
import { cursorModeCatalog } from './cursor/modes.js'
import { CURSOR_SDK_MODULE, resolveCursorSdk } from './cursor/sdk-resolve.js'

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
  cursor: cursorModeCatalog,
}

// ---------------------------------------------------------------------------
// Embedded-runtime availability probes
// ---------------------------------------------------------------------------

/**
 * Availability probe for each vendor whose runtime ships **inside** c3 rather
 * than as a host CLI — the counterpart of the launcher's `HOST_BINARIES` table.
 *
 * Partial over {@link VendorId} on purpose, and the two tables partition the
 * union between them: a vendor is either resolved as a binary (probed by the
 * ProcessLauncher) or resolved as an in-process module (probed here). That split
 * is what lets the settings snapshot answer "is this vendor runnable" for every
 * vendor without naming one — `if (vendor === 'cursor')` never appears.
 *
 * The probe registered for cursor is the SAME resolution `server.ts` gates adapter
 * construction on at startup and the driver loads through, so what the settings
 * page reports, where the module comes from, and what the kernel can actually
 * build can never disagree.
 */
export interface EmbeddedRuntimeProbeResult {
  /** Whether the runtime is resolvable from this process right now. */
  available: boolean
  /** Which source it resolved from; absent when nothing resolved. */
  origin?: VendorRuntimeOrigin
  /** Absolute location of the resolved runtime; absent when nothing resolved. */
  location?: string
}

export interface EmbeddedRuntimeSpec {
  /** The package the runtime lives in — what the diagnostics row names. */
  readonly module: string
  /** Resolve the runtime, reporting availability and where it came from. */
  readonly probe: () => EmbeddedRuntimeProbeResult
}

export const EMBEDDED_RUNTIME_PROBES: Partial<Record<VendorId, EmbeddedRuntimeSpec>> = {
  cursor: {
    module: CURSOR_SDK_MODULE,
    probe: () => {
      const resolution = resolveCursorSdk()
      return {
        available: resolution.available,
        ...(resolution.origin ? { origin: resolution.origin } : {}),
        ...(resolution.entry ? { location: resolution.entry } : {}),
      }
    },
  },
}
