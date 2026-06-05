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
  VendorAdapter,
} from './types.js'

export { createClaudeAdapter } from './claude/index.js'
export { upsertBlock, CanonicalAccumulator } from './canonical-accumulator.js'
