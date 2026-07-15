/**
 * Vendor-neutral Agent abstraction — the geology under every agent vendor
 * (ADR-0011, Phase 1). Three interfaces + a neutral permission policy + a
 * capability ledger let c3 drive Claude or Codex through one shape,
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
 * whole turn via `AbortSignal`. Future vendors may approve out-of-loop via a
 * `permission.updated` event + REST write-back. Claude approves in-the-loop via
 * a blocking `canUseTool` callback. A neutral interface that pretended these
 * were the same would lie; instead, the shared surface is the *required* subset
 * and everything divergent is a probed {@link AdapterCapabilities} flag.
 */

import type {
  ActionMode,
  ToolGate,
  AdapterCapability,
  CanonicalMessage,
  SessionCapability,
  SessionCapabilities,
  SkillSupportState,
  ToolManifestEntry,
  VendorId,
} from '@ccc/shared/protocol'

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
  CapabilityState,
  SessionCapability,
  SessionCapabilities,
  // The neutral permission grid + per-vendor mode catalog were promoted to the
  // wire (2026-06-07-012) — same SoT move as CanonicalMessage/AdapterCapability.
  ActionMode,
  ToolGate,
  NeutralMode,
  ModeToken,
  VendorModeDescriptor,
  VendorModeCatalog,
  ToolManifestEntry,
  // A user-attached prompt image (base64 + media type). Threaded neutrally to
  // both vendor drivers via {@link DriverStartOptions.images}; each adapter does
  // its own encoding (Claude → base64 image block, Codex → local_image path).
  PromptImage,
} from '@ccc/shared/protocol'

// ---------------------------------------------------------------------------
// Neutral permission policy (PermissionMode 1:1 mapping is abandoned)
// ---------------------------------------------------------------------------

// `ActionMode` and `ToolGate` (the neutral permission grid) now live on the WIRE
// (`shared/protocol.ts`) as the single SoT — re-exported above — alongside the
// per-vendor `VendorModeCatalog` that translates each vendor's native mode tokens
// into this grid and back (2026-06-07-012). They were first authored here in 011
// and promoted unchanged.

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
// Adapter capabilities — contract methods + boolean flags + structured states
// ---------------------------------------------------------------------------

/**
 * The probed capability ledger. The unconditional **interface contract** — the
 * methods every adapter exposes regardless of ability — is `AgentDriver.start`,
 * `AgentRun.messages`/`abort`/`sessionId`, `SessionStore.list`/`read`, and
 * `ApprovalBridge.onRequest`. Method *presence* is the contract; what each method
 * can actually deliver is the ledger's job: the seven booleans gate the optional
 * live-run controls, and {@link sessions} carries the structured state of the
 * session-lifecycle operations (so `SessionStore.list`/`read` always *exist* and
 * can honestly report `none`, `partial`, `full`, or `temporarily-unavailable`).
 *
 * The seven boolean fields below are **optional, degradable** live-run controls:
 * the upper layer probes the flag, calls the matching optional method when true,
 * and degrades gracefully when false. A `false` flag means the corresponding
 * optional method on {@link AgentRun} (or behavior) is absent — calling it is a
 * programming error the probe is there to prevent.
 *
 * The {@link sessions} sub-ledger is the structured-state half (ADR-0011
 * amendment): the session-lifecycle operations (list/read/resume/rename/delete)
 * are NOT honestly boolean — a vendor can do one `full`, `partial`, `none`, or
 * `temporarily-unavailable`. A boolean would erase the `none` vs
 * `temporarily-unavailable` distinction the UI must render, so those operations
 * carry a {@link import('@ccc/shared/protocol').CapabilityState} instead of being
 * the unflagged "required contract" they once were.
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
   * Claude (blocking `canUseTool`) = true; Codex = false.
   * = true; **Codex = false** (008 NO-GO: stdin closes after dispatch, no
   * write-back half-channel). When false, the adapter has no live approval point
   * and degrades to launch-time policy (Codex `sandboxMode` + `approvalPolicy`).
   */
  readonly perToolApproval: boolean
  /**
   * SDK-level task-tool surface (TaskCreate / TaskList / TaskUpdate / TaskGet).
   * Current vendors (Claude, Codex) support the SDK task
   * tools, so this is `true` for every vendor shipping today. The flag exists
   * for future vendors that may not offer a native task API.
   */
  readonly taskStore: boolean
  /**
   * Native in-run user-input ability: the vendor can pause mid-turn to ask the
   * human a question and resume with their answer (Claude's `AskUserQuestion`
   * over the blocking `canUseTool` write-back). **Claude = true; Codex = false**
   * (008 NO-GO: `codex exec` closes stdin after dispatch — no event ever requests
   * input, no channel writes one back). When false, c3 cannot intercept a native
   * prompt; user-input intents (e.g. `save_intents`) instead route through the
   * c3-controlled HTTP-MCP gate, which raises a normal WorkCenter `permission_request`
   * the human answers (the visible degradation path). Surfaced to the console via
   * `settings.vendorCapabilities` so a Codex session can label the gap honestly.
   */
  readonly nativeUserInput: boolean
  /**
   * Structured session-lifecycle capability states (ADR-0011 amendment). The
   * vendor's honest self-report for list/read/resume/rename/delete — each a
   * 4-state {@link import('@ccc/shared/protocol').CapabilityState}, the upper
   * layer degrades on (UI gates rename/delete buttons; the run loop knows a
   * `none`-read vendor has no back-readable history). Travels to the web on the
   * `VendorHostStatus.sessions` field, so the console renders by state, not vendor.
   */
  readonly sessions: SessionCapabilities
}

/**
 * Compile-time pin: the **boolean** ledger keys and the wire `AdapterCapability`
 * enum must stay identical, in both directions. `sessions` is excluded — it is the
 * structured sub-ledger (pinned separately, by `SessionCapabilities`'s own keys),
 * not a wire `AdapterCapability` name. If either side adds/removes a boolean
 * capability without the other, one of these assignments stops type-checking —
 * the drift is caught at build, not on the wire.
 */
type _BooleanCapKeys = Exclude<keyof AdapterCapabilities, 'sessions'>
type _CapKeysSubsetOfEnum = _BooleanCapKeys extends AdapterCapability ? true : never
type _EnumSubsetOfCapKeys = AdapterCapability extends _BooleanCapKeys ? true : never
const _capKeysMatchEnum: [_CapKeysSubsetOfEnum, _EnumSubsetOfCapKeys] = [true, true]
void _capKeysMatchEnum

/**
 * The same drift-pin for the structured session sub-ledger: `SessionCapabilities`
 * interface keys ↔ the wire `SessionCapability` enum, both directions. Adding a
 * session operation to one side without the other stops type-checking here.
 */
type _SessKeysSubsetOfEnum = keyof SessionCapabilities extends SessionCapability ? true : never
type _SessEnumSubsetOfKeys = SessionCapability extends keyof SessionCapabilities ? true : never
const _sessKeysMatchEnum: [_SessKeysSubsetOfEnum, _SessEnumSubsetOfKeys] = [true, true]
void _sessKeysMatchEnum

// ---------------------------------------------------------------------------
// The three interfaces
// ---------------------------------------------------------------------------

/**
 * Vendor-neutral description of a remote (HTTP) MCP server to attach to a run
 * (2026-06-12-005). Each driver translates it to its native MCP config (codex →
 * `config.mcp_servers.<name> = { url }`;
 * a later intent). The URL is loopback (c3's own HTTP MCP route); `bearerTokenEnvVar`
 * names an env var the vendor reads a bearer token from (codex-only knob; omit ⇒ none).
 * c3's only current producer is the intent route, which carries its per-run binding
 * token in the URL query — so this stays a minimal `{ url }` description, not a
 * full MCP-config union.
 */
export interface RemoteMcpServer {
  readonly type: 'http'
  readonly url: string
  /**
   * Tool names to enable for this server in drivers that require an explicit
   * allowlist. Omit when the driver should use its route-specific default.
   */
  readonly enabledTools?: readonly string[]
  readonly bearerTokenEnvVar?: string
}

/** Caller-resolved inputs to start one run, neutral across vendors. */
export interface DriverStartOptions {
  prompt: string
  /**
   * Stable, per-turn-identical system instruction delivered on the vendor's
   * system channel — the cacheable prefix half of the prompt split
   * (hide-session-system-instructions). Claude maps it to its preset system
   * `append`; Codex has no separate system role, so its driver places it as a
   * leading text item at position 0 of the input array (byte-identical across
   * turns, which is what the API prompt cache keys off). Never echoed to the
   * client. Omit ⇒ no system instruction (the user turn stands alone).
   */
  systemInstruction?: string
  /**
   * Images attached to this turn's prompt (2026-06-16). Vendor-neutral — each
   * driver encodes them its own way: Claude inlines a base64 `image` content
   * block on the user message; Codex writes each to a temp file and passes the
   * path as a `local_image` (`codex exec --image <path>`), cleaning the temp
   * files when the turn ends. Omit / empty ⇒ a text-only turn. Non-image media
   * types are rejected upstream (the server boundary), so a driver may assume
   * every entry is a supported image.
   */
  images?: import('@ccc/shared/protocol').PromptImage[]
  /** Working directory for the run (the isolated worktree in worktree mode). */
  cwd: string
  /**
   * The registered workspace root — the project-config / audit key, distinct from
   * {@link cwd} (which is the effective worktree). Only the Claude driver consumes
   * it (it re-enters `runClaude`'s consensus gateway, which reads config off the
   * root); other drivers ignore it. Omit ⇒ the driver falls back to {@link cwd}.
   */
  workspacePath?: string
  /**
   * Extra absolute directories the vendor may permit outside {@link cwd}. The
   * launch layer resolves these from the owning workspace; adapters that support
   * them pass them to their native sandbox configuration.
   */
  additionalDirectories?: string[]
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
   * instead.
   */
  baseUrl?: string
  /** Raw provider api key override, paired with {@link baseUrl} (driver-path vendors). */
  apiKey?: string
  /**
   * Codex-only: the custom provider's wire protocol (`responses`/`chat`). The
   * codex driver routes on it — `chat` ⇒ the in-process Responses→Chat relay,
   * `responses` ⇒ direct to the provider (2026-06-12-006). Omit ⇒ no custom
   * provider (system mode / first-party) ⇒ direct. Other vendors ignore it.
   */
  wireApi?: 'responses' | 'chat'
  /**
   * Path to an arapuca sandbox-wrapper script. When set, the driver MUST use
   * this path as the vendor binary executable instead of default host binary
   * resolution. The wrapper runs the vendor CLI as an arapuca-narrowed host
   * process (`arapuca run -v … -- <cli> "$@"`); the child inherits the driver's
   * spawn env, so no env-file is needed.
   */
  sandboxWrapperPath?: string
  /**
   * Remote (HTTP) MCP servers to attach to this run, keyed by server name
   * (2026-06-12-005). Each driver translates to its native MCP config; a driver
   * that does not support remote MCP ignores it. Currently produced only for the
   * intent comm-agent on the driver path (codex), carrying the three intent tools.
   */
  mcpServers?: Record<string, RemoteMcpServer>
  /**
   * Allow the run's sandboxed processes to reach the network (2026-06-15). Neutral
   * knob, orthogonal to filesystem write permission: a `plan`/read-only run can
   * still fetch over the network. Codex maps it to `ThreadOptions.networkAccessEnabled`
   * (its sandbox denies network by default, which is why work/intent/discussion
   * codex sessions previously failed any network call). Omit ⇒ vendor default
   * (codex = denied). Claude governs network via its tool allowlist and
   * ignore this flag.
   */
  networkAccess?: boolean
  /**
   * Enable the vendor's built-in web-search tool for this run (2026-06-15). Codex
   * maps it to `ThreadOptions.webSearchEnabled` + `webSearchMode: 'live'` (default
   * disabled). Separate from {@link networkAccess}: this is the agent's first-party
   * search/fetch capability, that is raw socket access for shell commands. Omit ⇒
   * vendor default (codex = disabled). Other vendors expose search via tools and
   * ignore this flag.
   */
  webSearch?: boolean
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

/** Intercept → suspend → write back. The neutral approval channel. For vendors
 * with `perToolApproval`, the adapter calls the registered handler when a tool
 * needs a decision and writes the result back (Claude: resolve the blocking
 * callback). For vendors without it (Codex), `onRequest`
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
 * JSONL under `~/.claude/projects/`, Codex via thread
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

// ---------------------------------------------------------------------------
// Task-store interface (ADR-0011 amendment: 4th neutral face)
// ---------------------------------------------------------------------------

/** Task lifecycle status — the common subset across all three vendor SDKs. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** A single task in a vendor's task list (neutral subset). */
export interface TaskData {
  /** SDK-assigned task id (string-normalised; vendor may use numbers internally). */
  readonly id: string
  /** Task title. */
  readonly subject: string
  /** Detailed description, when the vendor provides it. */
  readonly description?: string
  /** Lifecycle status. */
  readonly status: TaskStatus
  /** The agent name the task is assigned to, when known. */
  readonly owner?: string
  /** Ids of tasks this task depends on. */
  readonly blockedBy?: string[]
  /** Ids of tasks that depend on this task. */
  readonly blocks?: string[]
  /**
   * Vendor-specific extras the neutral surface does not model
   * (e.g., Codex's review state).
   */
  readonly vendorExtra?: Record<string, unknown>
}

/**
 * The task-tool face of a vendor: create/list/update/get tasks via the vendor's
 * SDK task-tool surface (TaskCreate / TaskList / TaskUpdate / TaskGet).
 * Present on a {@link VendorAdapter} iff `AdapterCapabilities.taskStore`
 * is `true` — the probe protocol (ADR-0011) applies: check the flag before
 * reaching for the interface.
 */
export interface TaskStore {
  /** Create a task in the given list with the given subject. Returns the created task (with vendor-assigned id). */
  create(list: string, subject: string): Promise<TaskData>
  /** List all tasks in the store. */
  list(): Promise<TaskData[]>
  /** Update one task's fields by id. Returns the updated task. */
  update(taskId: string, patch: Partial<TaskData>): Promise<TaskData>
  /** Get a single task by id. Returns `undefined` when not found. */
  get(taskId: string): Promise<TaskData | undefined>
  /**
   * Present iff the vendor supports push-based task updates
   * (e.g., SDK task-update events). Returns a disposer to
   * unsubscribe the handler.
   */
  onUpdate?(handler: (task: TaskData) => void): Disposer
}

/**
 * The cached self-report of one vendor's SKILL-discovery support (mount layer
 * 2/3). `state` reuses {@link SkillSupportState}; `sdkVersion` is the probed
 * vendor SDK/CLI version the report was taken against — a mismatch on re-read
 * invalidates the cache (an SDK upgrade may change discovery behaviour), forcing
 * a re-probe. `checkedAt` is the Unix-ms instant of the probe.
 */
export interface SkillSupportReport {
  state: SkillSupportState
  sdkVersion: string
  checkedAt: number
}

/**
 * Per-vendor SKILL mount face (mount layer 2/3, ADR-0016/0017). The three
 * methods are the contract every vendor implements; whether a mount is actually
 * built is gated by {@link detectSkillSupport} (a `none` state ⇒ no link, the
 * console greys the vendor, the session still launches). The flat layout is
 * fixed by spike A: a skill mounts as a single `_c3_<id>` dir symlinked straight
 * at its source dir (which holds `SKILL.md`); nested dirs are NOT discovered.
 */
export interface SkillLoader {
  readonly vendor: VendorId
  /**
   * The vendor's project-level skill-discovery directory, e.g.
   * `<projectDir>/.claude/skills`. The mount target for an id is this dir +
   * `/_c3_<id>`. Pure path math — does not touch the filesystem.
   */
  getVendorSkillDir(projectDir: string): string
  /**
   * Probe (with cache + SDK-version invalidation) whether this vendor's running
   * SDK/CLI will discover c3's mounted skills. A `none`/`temporarily-unavailable`
   * result means the upper layer must NOT build a link for this vendor.
   */
  detectSkillSupport(): Promise<SkillSupportReport>
  /**
   * Idempotently create the symlink `linkPath → target`. A link that already
   * exists and points at the same `target` is a no-op (the cache-hit skip lives
   * in the upper layer, but this stays safe under a redundant call).
   */
  ensureLink(target: string, linkPath: string): Promise<void>
}

/**
 * One vendor's full adapter: its driver, approval bridge, session store, and
 * skill mount face. Assembled per-vendor under `adapters/<vendor>/`; the upper
 * layer selects one by {@link VendorId} and treats it through these neutral
 * faces only.
 */
export interface VendorAdapter {
  readonly vendor: VendorId
  readonly capabilities: AdapterCapabilities
  readonly driver: AgentDriver
  readonly approval: ApprovalBridge
  readonly sessions: SessionStore
  /** The vendor's task-tool surface. Present iff `capabilities.taskStore`. */
  readonly tasks?: TaskStore
  readonly skill: SkillLoader
  /**
   * List the tools this vendor's SDK provides, classified as read or write.
   *
   * For the Claude adapter this includes both built-in SDK tools and workspace
   * MCP server namespace prefixes (`mcp__<server>__`). For Codex it
   * returns only the built-in SDK tool set. The result is a **static** pre-judged
   * list (not a runtime MCP server probe) — the same classification convention
   * used by the automation executor's `freezeTools()`.
   *
   * @param workspacePath - The workspace directory (used to resolve MCP config
   *   for adapters that support it — Claude uses this to derive MCP namespace
   *   prefixes).
   * @param mcpServers - Pre-resolved MCP server definitions keyed by server name.
   *   The caller (automations feature handler) loads this from the workspace config
   *   store and passes it here so the adapter does not need to import from
   *   `features/`. Ignored by adapters that don't support MCP (Codex).
   */
  listTools(
    workspacePath: string,
    mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
  ): ToolManifestEntry[]
}
