/**
 * Vendor-neutral agent abstractions: vendor ids, the neutral permission grid
 * and per-vendor mode catalog, host/CLI status, and the canonical message model.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

/**
 * **Claude's** permission-mode token set — the five values valid to pass to the
 * Agent SDK `query()`'s `permissionMode` option and `setPermissionMode()`. As of
 * 2026-06-07-012 this is no longer the universal wire "mode" type: it is exactly
 * `claudeModeCatalog`'s token list (one vendor's tokens). The neutral wire/
 * persistence representation is {@link ModeToken} (a `string` carrying ANY vendor's
 * native token), interpreted via that vendor's {@link VendorModeCatalog}. Every
 * `PermissionMode` literal is a valid `ModeToken`, so Claude code is unaffected.
 */
export type PermissionMode = 'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'

/** The known vendor ids as a runtime list (the type {@link VendorId} is the union). */
export const VENDOR_IDS: readonly VendorId[] = ['claude', 'codex']

// ---- Canonical agent message model (vendor-neutral) ----
//
// The wire SoT for the vendor-neutral envelope (ADR-0011 → ADR-0013). The
// canonical model was first defined inside `kernel/agent/adapters/types.ts`
// (011); 013 promotes the definitions here so the WIRE only ever gains a
// `vendor` dimension — it does NOT start a second schema per vendor. The kernel
// re-exports these (single SoT); `shared/protocol.ts` stays zero-runtime and
// SDK-free: NO `@anthropic-ai/claude-agent-sdk` (or any vendor SDK) type appears
// here (ADR-0009). SDK values are narrowed to canonical shapes inside each
// adapter before they ever travel on the wire.

/** The agent vendors c3 can drive. New vendors extend this union (ADR-0011). */
export type VendorId = 'claude' | 'codex'

/**
 * Where a session's native transcript store lives — the second frozen invariant
 * alongside {@link VendorId} (ADR-0015). A run's vendor data root (codex
 * `CODEX_HOME`, claude `CLAUDE_CONFIG_DIR`) differs between a host run and a
 * sandbox run, so a session's transcript physically lands in one or the other.
 * The scope is frozen at first bind (from whether the run was sandboxed) so the
 * read/resume path can always locate that store, even after the workspace's
 * sandbox toggle later changes. `host` for every pre-existing session.
 */
export type StoreScope = 'host' | 'sandbox'

// ---------------------------------------------------------------------------
// Neutral permission grid + per-vendor mode catalog (ADR-0011, 2026-06-07-012)
// ---------------------------------------------------------------------------

/**
 * What the run is allowed to *do*, orthogonal to how tools are gated (ADR-0011).
 * `plan` proposes without executing changes; `build` executes. Promoted here from
 * the kernel's `adapters/types.ts` so it is the single, SDK-free SoT both the wire
 * (this file) and the adapters re-export — the same promotion `CanonicalMessage`
 * and `AdapterCapability` already took. Claude's `plan` mode, Codex's read-only
 * `sandboxMode` translate INTO this dimension.
 */
export type ActionMode = 'plan' | 'build'

/**
 * How aggressively tools are gated, orthogonal to {@link ActionMode} (ADR-0011):
 *  - `always-ask`   — every tool prompts the human.
 *  - `on-sensitive` — read-only auto-allow; sensitive tools prompt (the default).
 *  - `trusted-prefix` — a trusted class (e.g. edits) auto-accepts; the rest gate.
 *  - `never-ask`    — auto-execute everything (Claude `bypassPermissions`).
 *
 * Replaces Claude's five-way `PermissionMode` as the *internal* permission truth;
 * each vendor's native mode token(s) translate into this 2-axis grid and back via
 * its {@link VendorModeCatalog}. The grid never round-trips 1:1 — see the catalog.
 */
export type ToolGate = 'always-ask' | 'on-sensitive' | 'trusted-prefix' | 'never-ask'

/** The neutral permission grid cell a mode token resolves to. */
export interface NeutralMode {
  actionMode: ActionMode
  toolGate: ToolGate
}

// ---------------------------------------------------------------------------
// Codex native permission types (2026-06-08 — dual-policy config)
// ---------------------------------------------------------------------------

/**
 * Codex sandbox isolation mode — a 1:1 mapping of `@openai/codex-sdk`'s
 * `SandboxMode`. Controls what filesystem write access the agent has.
 */
export type CodexSandboxMode = 'read-only' | 'workspace-write'

/**
 * Codex approval policy — a 1:1 mapping of `@openai/codex-sdk`'s
 * `ApprovalMode`. Controls when the agent asks the human for approval.
 */
export type CodexApprovalPolicy = 'never' | 'on-failure' | 'on-request'

/**
 * Dual-policy config for Codex sessions, replacing the single `ModeToken`
 * for the `codex` vendor. The two axes are orthogonal: `sandboxMode` gates
 * file-system write access and `approvalPolicy` controls the approval
 * frequency. When persisted in `WorkspaceSetting.defaultMode.codex` or
 * carried on the wire, the object form (this interface) is the new format;
 * the legacy string form (`ModeToken` like `'auto'`) is still accepted for
 * migration and degrades through the catalog + `gateToCodexPolicy`.
 */
export interface CodexPolicy {
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
}

/**
 * A vendor-native permission mode token (ADR-0011, 2026-06-07-012). The neutral
 * replacement for the Claude-centric `PermissionMode` as the wire/persistence
 * representation of a session's mode: it carries each vendor's OWN token (Claude
 * `plan`, Codex `read-only`), disambiguated by the session's
 * {@link VendorId}. A bare `string` by design — the closed set per vendor lives in
 * that vendor's {@link VendorModeCatalog}, not in this type. `PermissionMode`
 * (still defined above) is now just *Claude's* token set, a subset of this.
 */
export type ModeToken = string

/**
 * One selectable mode in a vendor's catalog: its native {@link token}, the web
 * i18n leaf key {@link labelCode} the console renders it through, and the neutral
 * {@link NeutralMode} grid cell it maps to (the semantic bridge the kernel reasons
 * over). The forward map (token → grid) is total per vendor; the reverse (grid →
 * token) picks the nearest declared token (the catalog has fewer cells than the
 * 2×4 grid), exactly as Claude's `permission-map` did before the generalization.
 */
export interface VendorModeDescriptor {
  /** Vendor-native mode token; round-trips as `SessionInfo.mode`/`set_mode`/etc. */
  token: string
  /** Web i18n leaf key for the label (e.g. `nav.mode.plan.label`). Not translated text. */
  labelCode: string
  /** The neutral grid this mode maps to (the kernel's permission truth). */
  actionMode: ActionMode
  toolGate: ToolGate
}

/**
 * One vendor's full mode catalog (ADR-0011, 2026-06-07-012): the ordered list of
 * modes the console offers for that vendor plus the {@link defaultToken} a new
 * session starts in. The single SoT for token ⇄ grid translation — each adapter
 * declares its catalog, the generic `tokenToGrid`/`gridToToken` helpers operate on
 * it, and the kernel/web both consume it by `vendor` (no `if (vendor === …)`).
 * Travels to the web on the `settings.vendorModes` field for the mode picker.
 */
export interface VendorModeCatalog {
  vendor: VendorId
  /** Selectable modes in display order. */
  modes: VendorModeDescriptor[]
  /** The token a new session defaults to; an invariant: it MUST be one of `modes`. */
  defaultToken: string
}

/**
 * One vendor's host-CLI presence (ADR-0012), surfaced to the web so the
 * new-session agent picker can grey out an agent whose binary is not on PATH and
 * the settings diagnostics panel can list what is/isn't installed — together with
 * the resolved absolute path of each installed binary, so the operator can see
 * exactly which executable c3 will launch.
 *
 * The optional multi-version fields (`installedVersions`/`activeVersion`/
 * `downloadTargetVersion`/`lastCheckedAt`/`lastRemoteCheckAt`/`lastError`) are a
 * backward-compatible extension: they carry the manifest-derived multi-version
 * state for the vendor CLI settings panel. Older clients ignore them; the
 * classic `present`/`path`/`version` fields keep their original semantics for
 * session-availability gating.
 */
export interface VendorHostStatus {
  vendor: VendorId
  /** Whether c3 resolved a runnable vendor CLI from any allowed source. */
  present: boolean
  /** The probed executable name (e.g. `claude`). */
  binary: string
  /** The resolved absolute path of the binary, or `null` when it is not installed. */
  path: string | null
  /** Resolution source: env override, c3 managed vendor dir, degraded PATH fallback, or failure. */
  source?: string
  version?: string
  expectedVersion?: string
  compatibleRange?: string
  error?: string
  managedError?: string
  /** Operator-facing install guidance shown when the binary is missing. */
  installHint: string
  /** Installed managed versions selectable as the effective version (failed entries excluded). */
  installedVersions?: VendorCliVersionEntry[]
  /** The effective managed version currently resolved at runtime (null/absent when none). */
  activeVersion?: string
  /** The download target — latest compatible version confirmed by the last sync. */
  downloadTargetVersion?: string
  /** Last local check timestamp (ISO). */
  lastCheckedAt?: string
  /** Last remote (npm packument) check timestamp (ISO). */
  lastRemoteCheckAt?: string
  /** Last sync/install or resolution-degradation error (absent when healthy). */
  lastError?: string
}

/** Runtime availability of the process-level sandbox driver. */
export interface SandboxHostStatus {
  present: boolean
  binary: 'arapuca'
  /** Resolved absolute executable path, or `null` when unavailable. */
  path: string | null
  error?:
    | 'arapuca-missing'
    | 'platform-unsupported'
    | 'nested-sandbox-unsupported'
    | 'path-illegal'
    | 'launch-failed'
}

/**
 * One selectable installed managed vendor CLI version, surfaced to the settings
 * panel. `failed` history entries are filtered out before being sent — only
 * `installed`/`selected` entries appear as selectable radio options.
 */
export interface VendorCliVersionEntry {
  version: string
  installedAt?: string
  sourceTag?: string
  status: 'installed' | 'selected'
}

/**
 * Session→agent binding counts (ADR-0015) shown in the settings console to make
 * concrete that changing the default agent is **not** retroactive: every already
 * recorded session keeps its own agent (and frozen vendor); only future sessions
 * adopt the new default.
 */
export interface SessionBindingStats {
  /** Real sessions with a frozen vendor *fact* — they keep their agent/vendor. */
  bound: number
  /** Pending sessions with an explicit *intent*, not yet bound by a first run. */
  pending: number
}

/**
 * The wire-facing capability enum (the names of every optional/degradable
 * adapter capability, currently seven: six live-run controls + taskStore).
 * The kernel's `AdapterCapabilities` boolean ledger is keyed by exactly these
 * names; a type-level assertion there pins the two together so they cannot drift. "Required" capabilities (start/messages/abort/
 * list/read/onRequest) are the unconditional interface contract and are NOT
 * enumerated here — only the probed, degradable ones are.
 */
export type AdapterCapability =
  | 'interrupt'
  | 'setActionMode'
  | 'streamingPush'
  | 'inProcessMcp'
  | 'forkSession'
  | 'perToolApproval'
  | 'taskStore'
  | 'nativeUserInput'

/**
 * A structured capability *state* — the honest grade of a degradable ability,
 * richer than a `boolean` (ADR-0011 addendum). Where the six {@link AdapterCapability}
 * live-run controls are genuinely binary (a vendor either has a mid-turn interrupt
 * point or it does not), the **session-lifecycle** operations admit intermediate
 * grades a flag cannot express:
 *  - `'none'`    — the vendor has no such ability at all (Codex has no listing/read
 *                  API; its store returns empty rather than fabricate a transcript).
 *  - `'partial'` — the ability exists but is reduced (e.g. resumes the thread but
 *                  cannot reconstruct full prior history).
 *  - `'full'`    — first-class support (the Claude reference grade).
 *  - `'temporarily-unavailable'` — the ability normally exists but is unreachable
 *                  *right now* (for a remote-backed future vendor whose service
 *                  is down). Distinct from `'none'`: the upper layer/UI
 *                  degrades softly (greyed-out, "try again later") rather than
 *                  hiding the affordance as structurally absent.
 */
export type CapabilityState = 'none' | 'partial' | 'full' | 'temporarily-unavailable'

/**
 * The session-lifecycle operations whose support a vendor self-reports as a
 * {@link CapabilityState} (ADR-0011 addendum). Unlike the binary
 * {@link AdapterCapability} live-run controls, these were the "required, unflagged"
 * contract — but Phase 0 proved that contract is NOT universal (Codex has neither
 * `list` nor `read`), so they are graded honestly instead. The kernel's
 * `SessionCapabilities` is keyed by exactly these names (a type-level assertion
 * pins the two together so they cannot drift).
 */
export type SessionCapability = 'list' | 'read' | 'resume' | 'rename' | 'delete'

/**
 * A vendor's graded support for each session-lifecycle operation (ADR-0011
 * addendum). The upper layer (and UI) reads a state and degrades by it — never by
 * vendor identity — so a new vendor that self-reports its grades is correctly
 * degraded with no `if (vendor === …)` branch anywhere above the adapter.
 */
export interface SessionCapabilities {
  /** Enumerate a workspace's sessions. Codex: `'full'` via local JSONL scan. */
  readonly list: CapabilityState
  /** Back-read a session's history as canonical messages. Codex: `'full'` via local JSONL read. */
  readonly read: CapabilityState
  /** Continue an existing session by id (vendor-native resume). */
  readonly resume: CapabilityState
  /** Rename a session. Only the vendors whose store supports it report above `'none'`. */
  readonly rename: CapabilityState
  /** Delete a session. Only the vendors whose store supports it report above `'none'`. */
  readonly delete: CapabilityState
}

/**
 * The only role the canonical model commits to. Codex carries no role on its
 * items and must synthesize one (item-type → role); Claude carries it
 * natively. `system`/`result` SDK frames are NOT messages — they map to side
 * channels (session id, turn end) or the {@link ApprovalBridge} stream, never to
 * a CanonicalMessage.
 */
export type CanonicalRole = 'user' | 'assistant'

/**
 * A tool's return, embedded on its {@link CanonicalBlock} `tool_use` (011 D3
 * ruling): there is NO standalone `tool_result` block.
 */
export interface CanonicalToolResult {
  /** Flattened display content (vendor result shapes collapse to a string). */
  content: string
  /** Whether the tool errored. */
  isError: boolean
  /** Block-result overflow: Codex `exit_code`/`aggregated_output`, … */
  vendorExtra?: Record<string, unknown>
}

/**
 * A content block. **011 D3 ruling:** there is NO standalone `tool_result`
 * block — a tool's return is embedded as `tool_use.result`, back-filled by
 * id-upsert when it arrives. This matches the incremental vendors (Codex
 * collapses a tool into a single in-place item)
 * more naturally than Claude's two-block split, which the Claude adapter folds
 * inward.
 *
 * The union is the **three-vendor common set** (`text`/`thinking`/`tool_use`).
 * Vendor-unique kinds (Codex `reasoning`, …) are NOT promoted
 * to their own variant yet (ADR-0013 D-D: no adapter produces them); they ride
 * `vendorExtra`. A future `vendorTag`-discriminated escape variant is the
 * extension point. `thinking.signature` / `redacted_thinking` drop to
 * `vendorExtra` (encrypted, cross-vendor-meaningless). Block `id` exists for
 * upsert correlation, not cross-vendor identity.
 */
export type CanonicalBlock =
  | {
      type: 'text'
      text: string
      id?: string
      vendorExtra?: Record<string, unknown>
    }
  | {
      type: 'thinking'
      thinking: string
      id?: string
      vendorExtra?: Record<string, unknown>
    }
  | {
      type: 'tool_use'
      /** Correlation id (Claude `tool_use.id`, Codex item id). */
      id: string
      name: string
      input: unknown
      /** Embedded return, absent until the tool completes (D3 in-place back-fill). */
      result?: CanonicalToolResult
      vendorExtra?: Record<string, unknown>
    }

/**
 * A vendor-spanning message envelope. The 010 diff pinned the true common set:
 * `vendor`/`sessionId` are unconditional; `role`/`blocks`/`ts`/`turnId?` carry a
 * discount (synthesized, append-with-upsert, c3-stamped, or droppable). Anything
 * that does not survive all three vendors lands in {@link vendorExtra}, never the
 * top level ("宁丢勿强塞" — drop before you fake a union).
 *
 * **Two-form upsert (ADR-0013).** Blocks are append-with-**id-upsert**, not
 * append-only: a consumer keys blocks by `(sessionId, block.id)`. Both vendor
 * forms collapse to this rule — Claude emits a whole message (full block set,
 * idempotent re-emit) and Codex emits incremental `ItemUpdated` frames that
 * revise an earlier block in place. Approval/permission events are NOT part of
 * this model — they ride the {@link ApprovalBridge} stream so the envelope never
 * becomes a god type.
 */
export interface CanonicalMessage {
  /** Which vendor produced this (010: the `vendor` tag is required, not optional). */
  vendor: VendorId
  /** The one unconditional common field. Source: `session_id`/`threadId`/`sessionID`. */
  sessionId: string
  /** Turn grouping. Semantics differ per vendor and are not uniformly available — droppable. */
  turnId?: string
  /** `assistant` for model output; `user` for prompts/tool returns. Codex synthesizes this. */
  role: CanonicalRole
  /**
   * Append-only with **id-upsert**: incremental vendors (Codex item
   * part) revise an earlier block in place rather than stacking a new one, so a
   * consumer keys blocks by {@link CanonicalBlock} id, not array position.
   */
  blocks: CanonicalBlock[]
  /**
   * c3 ingest timestamp (epoch ms), NOT a vendor-authoritative value — only
   * The vendor's own time,
   * if any, goes to {@link vendorExtra}.
   */
  ts: number
  /**
   * Audit marker: this turn's tool call(s) were auto-allowed by the vendor's own
   * permission rule engine WITHOUT a c3/human decision — i.e. c3 observed the
   * vendor reply to its own `permission.asked`
   * with no matching c3 write-back) and is reconstructing the bypass for the
   * audit trail (2026-06-06-003). Absent/`false` ⇒ a normal turn (either no
   * approval was needed, or c3/the human decided it). This is the ONE top-level
   * approval-derived field on the envelope; the live approval *request* stream
   * still rides the {@link ApprovalBridge}, never the message model.
   */
  preApproved?: boolean
  /** Envelope-level overflow: `usage`, `parent_tool_use_id`, vendor `time`, … */
  vendorExtra?: Record<string, unknown>
}
