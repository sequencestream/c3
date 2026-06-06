/**
 * Vendor-neutral Agent abstraction — the geology under every agent vendor
 * (ADR-0011, Phase 1). Three interfaces + a neutral permission policy + a
 * capability ledger let c3 drive Claude, Codex, or OpenCode through one shape,
 * while each vendor's SDK quirks stay locked inside its `adapters/<vendor>/`.
 *
 * The hard boundary (ADR-0009): NO `@anthropic-ai/claude-agent-sdk` (or any
 * other vendor SDK) type appears in this file or in `shared/protocol.ts`. SDK
 * values cross into an adapter as `unknown` and are narrowed at runtime; only
 * the canonical shapes below travel upward. `git grep '@anthropic' ` inside this
 * directory and `shared/` must stay empty of SDK type imports.
 *
 * Why neutral and not a Claude clone: the Phase 0 probes proved the vendors do
 * NOT share one mechanism. Codex (008) has NO per-tool runtime approval — its
 * stdin closes after dispatch, so a tool can only be allowed/denied for the
 * whole turn via `AbortSignal`. OpenCode (009) approves out-of-loop via a
 * `permission.updated` event + REST write-back. Claude approves in-the-loop via
 * a blocking `canUseTool` callback. A neutral interface that pretended these
 * were the same would lie; instead, the shared surface is the *required* subset
 * and everything divergent is a probed {@link AdapterCapabilities} flag.
 */

import type { AdapterCapability, CanonicalMessage, VendorId } from '@ccc/shared/protocol'

/**
 * The canonical message model now lives on the WIRE (`shared/protocol.ts`) so it
 * only ever gains a `vendor` dimension, never a second schema (ADR-0013). The
 * kernel re-exports the definitions for its consumers (single SoT); they were
 * first authored here in 011 and promoted to shared in 013 unchanged (D3
 * embedded-result preserved). `AdapterCapability` (the capability enum) likewise
 * lives on the wire; the boolean ledger below is keyed by it.
 */
export type {
  VendorId,
  CanonicalRole,
  CanonicalToolResult,
  CanonicalBlock,
  CanonicalMessage,
  AdapterCapability,
} from '@ccc/shared/protocol'

// ---------------------------------------------------------------------------
// Neutral permission policy (PermissionMode 1:1 mapping is abandoned)
// ---------------------------------------------------------------------------

/**
 * What the run is allowed to *do*, orthogonal to how tools are gated. `plan`
 * proposes without executing changes; `build` executes. Claude's `plan` mode,
 * Codex's read-only `sandboxMode`, etc. translate into this dimension.
 */
export type ActionMode = 'plan' | 'build'

/**
 * How aggressively tools are gated, orthogonal to {@link ActionMode}:
 *  - `always-ask`   — every tool prompts the human.
 *  - `on-sensitive` — read-only auto-allow; sensitive tools prompt (the default).
 *  - `trusted-prefix` — a trusted class (e.g. edits) auto-accepts; the rest gate.
 *  - `never-ask`    — auto-execute everything (Claude `bypassPermissions`).
 *
 * Replaces Claude's five-way `PermissionMode`, which did not survive contact
 * with Codex (sandbox + approvalPolicy) or OpenCode. Each adapter translates its
 * native mode(s) into this 2-axis grid; the grid never translates 1:1 back.
 */
export type ToolGate = 'always-ask' | 'on-sensitive' | 'trusted-prefix' | 'never-ask'

/** The three verdicts a neutral policy yields for one tool call. */
export type PolicyVerdict = 'allow' | 'ask' | 'deny'

/** Context a {@link PermissionPolicy} reasons over (all caller-resolved). */
export interface PolicyContext {
  actionMode: ActionMode
  toolGate: ToolGate
  /** The run's working directory. */
  cwd: string
}

/**
 * The neutral permission decision function: `(toolName, input, ctx) → verdict`.
 * Each adapter owns the translation from its vendor's native permission concept
 * into this signature. `ask` is then resolved by the {@link ApprovalBridge} (for
 * vendors with `perToolApproval`); `allow`/`deny` short-circuit it.
 */
export type PermissionPolicy = (
  toolName: string,
  input: unknown,
  ctx: PolicyContext,
) => PolicyVerdict

// ---------------------------------------------------------------------------
// Adapter capabilities — required (no flag) vs optional/degradable (flagged)
// ---------------------------------------------------------------------------

/**
 * The probed capability ledger. **Required** capabilities are NOT flags here —
 * they are the interface contract every adapter satisfies unconditionally:
 * `AgentDriver.start`, `AgentRun.messages`/`abort`/`sessionId`,
 * `SessionStore.list`/`read`, and `ApprovalBridge.onRequest` always exist.
 *
 * Every field below is an **optional, degradable** capability: the upper layer
 * probes the flag, calls the matching optional method when true, and degrades
 * gracefully when false. A `false` flag means the corresponding optional method
 * on {@link AgentRun} (or behavior) is absent — calling it is a programming
 * error the probe is there to prevent.
 */
export interface AdapterCapabilities {
  /** Mid-turn interrupt without killing the run (Claude `q.interrupt`). Codex: only whole-turn abort ⇒ false. */
  readonly interrupt: boolean
  /** Switch action mode on a live run (Claude `setPermissionMode`). */
  readonly setActionMode: boolean
  /** Push the next user turn into the *live* session (Claude streaming-input / agent teams). */
  readonly streamingPush: boolean
  /** Expose in-process MCP servers (Claude `createSdkMcpServer`). */
  readonly inProcessMcp: boolean
  /** Fork/branch an existing session (Claude `forkSession`). */
  readonly forkSession: boolean
  /**
   * In-the-loop, per-tool runtime approval (intercept → suspend → write back).
   * Claude (blocking `canUseTool`) = true; OpenCode (`permission.updated` + REST)
   * = true; **Codex = false** (008 NO-GO: stdin closes after dispatch, no
   * write-back half-channel). When false, the adapter has no live approval point
   * and degrades to launch-time policy (Codex `sandboxMode` + `approvalPolicy`).
   */
  readonly perToolApproval: boolean
}

/**
 * Compile-time pin: the boolean ledger's keys and the wire `AdapterCapability`
 * enum must stay identical, in both directions. If either side adds/removes a
 * capability without the other, one of these assignments stops type-checking —
 * the drift is caught at build, not on the wire.
 */
type _CapKeysSubsetOfEnum = keyof AdapterCapabilities extends AdapterCapability ? true : never
type _EnumSubsetOfCapKeys = AdapterCapability extends keyof AdapterCapabilities ? true : never
const _capKeysMatchEnum: [_CapKeysSubsetOfEnum, _EnumSubsetOfCapKeys] = [true, true]
void _capKeysMatchEnum

// ---------------------------------------------------------------------------
// The three interfaces
// ---------------------------------------------------------------------------

/** Caller-resolved inputs to start one run, neutral across vendors. */
export interface DriverStartOptions {
  prompt: string
  /** Working directory for the run. */
  cwd: string
  /** Aborts the run (the universal, all-vendor control). */
  signal: AbortSignal
  /** Starting action mode + tool gate (the neutral replacement for PermissionMode). */
  actionMode: ActionMode
  toolGate: ToolGate
  /** Resume an existing session by id. Omit for a new session. */
  resume?: string
  /** Model alias/id override. Omit ⇒ adapter default. */
  model?: string
  /** Child-process env overrides (e.g. an agent's base URL / key). */
  envOverrides?: Record<string, string>
  /**
   * Raw provider base URL override for driver-path vendors whose SDK takes it as
   * a constructor option rather than an env var (Codex). Omit ⇒ vendor default /
   * system config (2026-06-06-007). Claude carries this via {@link envOverrides}
   * instead; opencode resolves it server-side, so its driver ignores this.
   */
  baseUrl?: string
  /** Raw provider api key override, paired with {@link baseUrl} (driver-path vendors). */
  apiKey?: string
}

/**
 * Vendor-neutral driver: the lifecycle + streaming message iteration face of an
 * agent. `start` is the only required entry; the run it returns carries the
 * optional/degradable controls gated by {@link AdapterCapabilities}.
 */
export interface AgentDriver {
  readonly vendor: VendorId
  readonly capabilities: AdapterCapabilities
  /** Begin a run. Required. */
  start(opts: DriverStartOptions): Promise<AgentRun>
}

/**
 * A live run. Required: `sessionId` (resolves once the vendor reports it),
 * `messages` (the canonical stream), `abort` (whole-turn kill — every vendor has
 * at least this). Optional methods exist iff the matching capability flag is set.
 */
export interface AgentRun {
  /** Resolves with the vendor's session id once reported (Claude `init`, etc.). Required. */
  sessionId(): Promise<string>
  /** The canonical message stream, append-with-upsert. Required. */
  messages(): AsyncIterable<CanonicalMessage>
  /** Kill the whole turn. The one control every vendor supports. Required. */
  abort(): void

  /** Mid-turn interrupt. Present iff `capabilities.interrupt`. */
  interrupt?(): Promise<void>
  /** Switch action mode on the live run. Present iff `capabilities.setActionMode`. */
  setActionMode?(mode: ActionMode): Promise<void>
  /** Push another user turn into the live session. Present iff `capabilities.streamingPush`. */
  pushInput?(text: string): void
  /** Fork the session, returning the new id. Present iff `capabilities.forkSession`. */
  forkSession?(): Promise<string>
}

/** A handler that resolves one approval request to a decision. */
export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>

/** A tool call awaiting a decision. Vendor correlation keys stay inside the adapter. */
export interface ApprovalRequest {
  /** c3-minted id, stable for the life of the request. */
  requestId: string
  toolName: string
  input: unknown
}

/** The neutral decision written back to the vendor. */
export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; reason: string }

/** Undo a subscription. */
export type Disposer = () => void

/**
 * Intercept → suspend → write back. The neutral approval channel. For vendors
 * with `perToolApproval`, the adapter calls the registered handler when a tool
 * needs a decision and writes the result back (Claude: resolve the blocking
 * callback; OpenCode: REST POST). For vendors without it (Codex), `onRequest`
 * registers a handler that simply never fires — approval degraded to launch-time
 * policy, no live interception point exists.
 */
export interface ApprovalBridge {
  /** Register the decision handler. Returns a disposer. Required. */
  onRequest(handler: ApprovalHandler): Disposer
}

/** A session in the store's listing (neutral subset). */
export interface SessionSummary {
  sessionId: string
  title: string
  /** Vendor-specific extras (mode, last-active, …) the caller may ignore. */
  vendorExtra?: Record<string, unknown>
}

/** Listing scope (the workspace/cwd whose sessions to enumerate). */
export interface SessionListOptions {
  cwd: string
}

/**
 * The dirtiest coupling — reading a vendor's on-disk transcript (Claude reads
 * JSONL under `~/.claude/projects/`, OpenCode reads via REST, Codex via thread
 * items) — locked behind one interface. `read` returns neutral
 * {@link CanonicalMessage}[]; no JSONL/SDK shape escapes.
 */
export interface SessionStore {
  /** Enumerate sessions for a workspace. Required. */
  list(opts: SessionListOptions): Promise<SessionSummary[]>
  /** Read a session's full history as canonical messages. Required. */
  read(sessionId: string, opts: SessionListOptions): Promise<CanonicalMessage[]>
  /**
   * Rename a session. Present iff the vendor supports it. Takes `opts` for the
   * same reason `read` does: some vendors (Claude) key the transcript by
   * workspace dir, not by id alone.
   */
  rename?(sessionId: string, name: string, opts: SessionListOptions): Promise<void>
  /** Delete a session. Present iff the vendor supports it. */
  delete?(sessionId: string, opts: SessionListOptions): Promise<void>
}

/**
 * One vendor's full adapter: its driver, approval bridge, and session store.
 * Assembled per-vendor under `adapters/<vendor>/`; the upper layer selects one
 * by {@link VendorId} and treats it through these neutral faces only.
 */
export interface VendorAdapter {
  readonly vendor: VendorId
  readonly capabilities: AdapterCapabilities
  readonly driver: AgentDriver
  readonly approval: ApprovalBridge
  readonly sessions: SessionStore
}
