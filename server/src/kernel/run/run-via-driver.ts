/**
 * Vendor-neutral run path via {@link AgentDriver} (2026-06-06-003). This is the
 * FIRST run that flows through the neutral adapter interface rather than the
 * claude-hardwired `runClaude` loop — `launchRun` forks here when the session's
 * vendor is `codex`. It is deliberately the *minimal* driver route:
 * it does NOT reuse the claude path's degradation chain, socket auto-resume FSM,
 * consensus, or intent profile — those are claude-shaped and out of scope for
 * the first non-Claude integration. The claude path stays byte-for-byte unchanged.
 *
 * Two translations live here:
 *  - **approval** — the driver's {@link ApprovalBridge} handler is wired to c3's
 *    existing browser approval registry (`permission_request` wire frame +
 *    `waitForDecision`), so a driver-path permission prompt reaches the same UI a
 *    Claude one does.
 *  - **canonical → wire** — driver-path sessions stream append-with-upsert canonical frames;
 *    the c3 wire protocol is claude-shaped incremental append. {@link WireEmitter}
 *    diffs successive frames into `assistant_text` deltas + one-shot `tool_use` /
 *    `tool_result`, so the existing web console renders a driver turn unchanged.
 */
import {
  PENDING_SESSION_PREFIX,
  type PromptImage,
  type RunEndReason,
  type ServerToClient,
} from '@ccc/shared/protocol'
import { mkdirSync } from 'node:fs'
import type {
  ApprovalHandler,
  CanonicalMessage,
  RemoteMcpServer,
  VendorAdapter,
  VendorId,
} from '../agent/adapters/types.js'
import type { PermissionRequestCtx } from '../permission/gateway.js'
import { MODE_CATALOGS, tokenToGrid } from '../agent/adapters/index.js'
import { codexPolicyToGrid } from '../agent/adapters/codex/driver.js'
import { resolveCodexGhTokenEnv } from '../agent/adapters/codex/gh-token.js'
import { getSpecsBase, getSandboxCodexHome } from '../config/workspace-path.js'
import {
  freezeSessionAgent,
  isDegradableError,
  resolveAgent,
  resolveSessionLaunch,
  resolveSessionStoreScope,
} from '../agent-config/index.js'
import { waitForDecision } from '../permission/index.js'
import { createSandboxWrapper } from '../sandbox/SandboxLauncher.js'
import { agentErrorEvent } from './agent-events.js'
import { modelUserTurn, type RunInject } from './prompt-delivery.js'
import {
  bindPending,
  clearPending,
  emit,
  finalizeRun,
  setStatus,
  type SessionRuntime,
} from '../../runs.js'
import type { EventBus, EventBusEvents } from '../events/event-bus.js'

/**
 * The intent comm-agent launch profile (read-only gate + disallowed-tools lock
 * + comm system prompt + `save_intents` MCP tool), resolved once before the
 * vendor fork in `launchRun`. Only present for `rt.sessionKind === 'intent'` runtimes.
 */
export interface IntentProfile {
  appendSystemPrompt: string
  disallowedTools: string[]
  /**
   * Bind the three intent tools over c3's loopback streamable-HTTP MCP route, the
   * SINGLE vendor-neutral transport both Claude and Codex now consume. The run-level
   * binding (workspace + live run id + abort signal) does not exist at profile-build
   * time, so the composition root returns a binder the run paths call once started:
   * it mints a per-run token, stands up the private MCP server, and returns the
   * neutral {@link RemoteMcpServer} descriptors plus a `dispose` to evict the token
   * at run end. `getRunId` reads the LIVE run id so a pending→real rebind routes the
   * save gate's `permission_request` to the bound session. `save_intents`'s
   * confirmation gate lives in its handler (`gatedSave`), so a vendor allow-rule that
   * skips `canUseTool` still raises a human prompt — Claude and Codex share one gate.
   */
  bindMcp: (binding: { workspacePath: string; getRunId: () => string; signal: AbortSignal }) => {
    servers: Record<string, RemoteMcpServer>
    dispose: () => void
  }
  gate: 'intent'
}

/**
 * The spec-authoring launch profile (write-confined gate + disallowed-tools lock
 * + spec system prompt), resolved before the vendor fork in `launchRun`. Only
 * present for `rt.sessionKind === 'spec'` runtimes. The confining directory itself
 * (`specDir`) rides on the runtime, not this static profile (it is per-run). Spec
 * Claude uses `canUseTool` for path-level write confinement. Codex has no
 * per-tool gate, so the driver path enforces the boundary at launch by moving cwd
 * to the specs root and forcing workspace-write/never.
 */
export interface SpecProfile {
  appendSystemPrompt: string
  disallowedTools: string[]
  gate: 'spec'
  /**
   * Bind the spec author's two read-only ledger query tools (`find_intents` /
   * `view_intent`) over the loopback HTTP MCP route — the SAME vendor-neutral
   * transport shape {@link IntentProfile.bindMcp} uses, so both run paths consume it
   * uniformly. There is no save and no confirmation gate, so the binder ignores the
   * `getRunId` / `signal` it is handed; the `workspacePath` binds the read to one
   * project. The same path runs on `reset_spec_session`, so a reset session gets the
   * tools too.
   */
  bindMcp: (binding: { workspacePath: string; getRunId: () => string; signal: AbortSignal }) => {
    servers: Record<string, RemoteMcpServer>
    dispose: () => void
  }
}

/**
 * The base launch profile bound to EVERY ordinary work session (`rt.sessionKind ===
 * 'work'`), resolved before the vendor fork in `launchRun` (2026-06-20). It
 * carries ONLY the `publish_event` MCP tool — no gate override, no
 * disallowed-tools lock — so a work run keeps its normal standard gate and tool
 * surface while gaining the ability to publish a vendor-neutral PR operation
 * event. Like {@link IntentProfile}, the per-run binding (live run id + abort
 * signal) does not exist at profile-build time, so the composition root returns
 * a binder the run paths call once started: both `runClaude` and the driver path
 * call {@link bindMcp} to bind `publish_event` over the loopback HTTP MCP route.
 */
export interface SessionMcpProfile {
  bindMcp: (binding: { workspacePath: string; getRunId: () => string; signal: AbortSignal }) => {
    servers: Record<string, RemoteMcpServer>
    dispose: () => void
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Tool names that the server marks as user-interaction tools. When the model calls
 * one of these, the server sets `isUserInteraction: true` on the emitted wire
 * events (`tool_use`, `tool_result`), so the web can identify interaction tools
 * without a client-side name-based allowlist.
 */
const USER_INTERACTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** Forced permission grid for intent comm sessions on the driver path. */
export function intentDriverModeForVendor(vendor: VendorId): {
  actionMode: import('@ccc/shared/protocol').ActionMode
  toolGate: import('@ccc/shared/protocol').ToolGate
} {
  return {
    actionMode: 'plan',
    toolGate: vendor === 'codex' ? 'never-ask' : 'always-ask',
  }
}

/** Forced permission grid for Codex spec-authoring sessions on the driver path. */
export function specDriverModeForVendor(vendor: VendorId): {
  actionMode: import('@ccc/shared/protocol').ActionMode
  toolGate: import('@ccc/shared/protocol').ToolGate
} {
  return {
    actionMode: 'build',
    toolGate: vendor === 'codex' ? 'never-ask' : 'always-ask',
  }
}

/**
 * Diffs append-with-upsert canonical frames into claude-shaped incremental wire
 * events. Text blocks emit only their new suffix; a tool_use emits once when first
 * seen and its result once it back-fills (D3). Keyed by block id (anonymous text
 * is bucketed under a single key.
 */
export class WireEmitter {
  private readonly textLen = new Map<string, number>()
  private readonly toolSeen = new Set<string>()
  private readonly resultSeen = new Set<string>()
  /** Tracks tool_use ids whose tool is a user-interaction tool (AskUserQuestion, ExitPlanMode). */
  private readonly userInteractionSeen = new Set<string>()

  constructor(private readonly send: (m: Parameters<typeof emit>[1]) => void) {}

  consume(msg: CanonicalMessage): void {
    for (const b of msg.blocks) {
      if (b.type === 'text') {
        const id = b.id ?? '__anon__'
        const prev = this.textLen.get(id) ?? 0
        if (b.text.length > prev) {
          this.send({ type: 'assistant_text', text: b.text.slice(prev) })
          this.textLen.set(id, b.text.length)
        }
      } else if (b.type === 'tool_use') {
        if (!this.toolSeen.has(b.id)) {
          this.toolSeen.add(b.id)
          const isUserInteraction = USER_INTERACTION_TOOLS.has(b.name)
          if (isUserInteraction) this.userInteractionSeen.add(b.id)
          // Carry the message-level `preApproved` audit marker onto the tool_use
          // frame (2026-06-06-004): a tool the vendor's own rule engine auto-allowed
          // never raised a `permission_request`, so this is the only signal the web
          // gets to color it "vendor pre-approved". Read at first-seen only — the
          // canonical flag is sticky, so a later result back-fill never flips it.
          this.send({
            type: 'tool_use',
            toolUseId: b.id,
            toolName: b.name,
            input: b.input ?? {},
            ...(msg.preApproved ? { preApproved: true } : {}),
            ...(isUserInteraction ? { isUserInteraction: true } : {}),
          })
        }
        if (b.result && !this.resultSeen.has(b.id)) {
          this.resultSeen.add(b.id)
          const ui = this.userInteractionSeen.has(b.id)
          this.send({
            type: 'tool_result',
            toolUseId: b.id,
            content: b.result.content,
            isError: b.result.isError,
            ...(ui ? { isUserInteraction: true } : {}),
          })
        }
      }
    }
  }
}

/**
 * Build the driver path's {@link ApprovalHandler}: the bridge between a vendor's
 * per-tool approval prompt and c3's browser approval registry. Extracted (and
 * dependency-injected) so the WorkCenter-event registration can be unit-tested
 * without a live driver.
 *
 * The order matters: `onPermissionRequest` fires FIRST (creating the
 * WaitUserInvolveEvent + broadcasting the todo list) BEFORE the `permission_request`
 * wire frame, mirroring the claude gateway. Then it blocks on `waitForDecision` —
 * the exact path a Claude prompt takes — and default-denies on stop.
 *
 * NB: Codex has no per-tool approval point (`perToolApproval: false`), so its
 * registered handler never fires — this path's live registration is exercised by
 * Codex's human-involvement is the `save_intents` gate (see save-gate.ts).
 */
export function makeDriverApprovalHandler(deps: {
  getRunId: () => string
  workspacePath: string
  sessionKind: string
  signal: AbortSignal
  emit: (runId: string, frame: ServerToClient) => void
  waitForDecision: (
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<{ decision: 'allow' | 'deny' }>
  onPermissionRequest?: (ctx: PermissionRequestCtx) => void
}): ApprovalHandler {
  return async (req) => {
    const isUI = USER_INTERACTION_TOOLS.has(req.toolName)
    const runId = deps.getRunId()
    // Register the WorkCenter event + broadcast BEFORE the wire frame, so a prompt
    // on a codex session lands in the pending-items panel + badge, not just
    // the active chat. sessionKind is the runtime kind (work / intent / spec / …).
    deps.onPermissionRequest?.({
      requestId: req.requestId,
      toolName: req.toolName,
      input: req.input,
      sessionId: runId,
      workspacePath: deps.workspacePath,
      sessionKind: deps.sessionKind,
    })
    deps.emit(runId, {
      type: 'permission_request',
      requestId: req.requestId,
      toolName: req.toolName,
      input: req.input,
      ...(isUI ? { isUserInteraction: true } : {}),
    })
    const { decision } = await deps.waitForDecision(req.requestId, deps.signal)
    return decision === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', reason: 'User denied in c3 UI' }
  }
}

/**
 * Run one turn through a vendor adapter's driver. Owns the same registry/emit
 * concerns `launchRun` does for claude (abort wiring, prompt echo, status flips,
 * pending→real bind, terminal turn_end) but via the neutral interface. Used for
 * `codex` (2026-06-06-007); any future driver-routed vendor reuses it.
 *
 * When `intentProfile` is present (intent comm session), its `appendSystemPrompt`
 * rides the driver's `systemInstruction` channel (codex delivers it as a leading
 * input text item), and `actionMode`/`toolGate` are overridden to reflect the
 * read-only gate (safe for non-Claude vendors that don't natively support the
 * full intent gate).
 *
 * `onPermissionRequest` (when wired at the composition root) registers a
 * WaitUserInvolveEvent before every human approval prompt — the WorkCenter
 * coverage for the driver path.
 */
export async function runViaDriver(
  rt: SessionRuntime,
  prompt: string,
  adapter: VendorAdapter,
  eventBus: EventBus<EventBusEvents>,
  intentProfile?: IntentProfile,
  onPermissionRequest?: (ctx: PermissionRequestCtx) => void,
  /** Images attached to this turn — the codex driver writes them to temp files
   *  and passes each as a `--image` path (2026-06-16). Omit ⇒ a text-only turn. */
  images?: PromptImage[],
  /**
   * Non-visible delivery channels for this turn (hide-session-system-instructions):
   * `systemInstruction` (a work run's SDD contract) and `userTurnPrefix` (a
   * slash-command dev skill). The system instruction rides the driver's dedicated
   * `systemInstruction` channel (codex delivers it as a leading input text item);
   * only the slash-command prefix leads the user turn. Either way the client echo
   * below still carries `prompt` (visible) alone (HS-R6).
   */
  inject?: RunInject,
  /**
   * The work-session base MCP profile (`publish_event`), present for
   * `rt.sessionKind === 'work'` runs (2026-06-20). Mutually exclusive with
   * `intentProfile` (a run is either an intent run or a session run); when set
   * and the vendor is codex, its driver MCP is bound over the localhost HTTP route.
   */
  sessionProfile?: SessionMcpProfile,
  /**
   * The spec-authoring profile, present for `rt.sessionKind === 'spec'` runs.
   * Mutually exclusive with intent/session profiles.
   */
  specProfile?: SpecProfile,
): Promise<void> {
  const workspacePath = rt.workspacePath
  let runId = rt.sessionId

  // Split the turn into the vendor system channel and the model user turn so the
  // stable role/contract can be cached across turns. The system text is the intent
  // comm-agent role, the spec-authoring contract, or a work run's SDD instruct
  // (`inject.systemInstruction`); the driver delivers it on codex's leading input
  // text item (byte-stable prefix). The user turn carries the slash-command dev
  // skill prefix + the visible body. The client echo stays the visible body alone.
  const systemInstruction =
    intentProfile?.appendSystemPrompt ??
    specProfile?.appendSystemPrompt ??
    inject?.systemInstruction
  const userTurn = modelUserTurn(prompt, inject)

  emit(runId, { type: 'user_text', text: prompt })

  const cycleAbort = new AbortController()
  rt.run = { abort: cycleAbort, handle: null }
  setStatus(runId, 'running')

  // Terminal reason for the run:settled lifecycle event (ADR-0018). Starts at
  // 'complete'; the catch flips it to 'error'; a user stop (aborted) wins in the
  // finally block. Drives event-triggered automations' reason filter (2026-06-08).
  let settledReason: RunEndReason = 'complete'

  // Wire the driver's approval bridge to c3's browser approval registry: a tool
  // prompt registers a WorkCenter event (onPermissionRequest), becomes a
  // `permission_request` frame, and the decision comes back through `waitForDecision`
  // (the exact path a Claude prompt takes). Default-deny on stop. `getRunId` reads the
  // live `runId` so a pending→real rebind routes to the bound session.
  const disposeApproval = adapter.approval.onRequest(
    makeDriverApprovalHandler({
      getRunId: () => runId,
      workspacePath,
      // The WorkCenter event carries the run's real business kind (intent / spec /
      // discussion / automation / work) verbatim — WorkCenter routes off it.
      sessionKind: rt.sessionKind,
      signal: cycleAbort.signal,
      emit,
      waitForDecision,
      onPermissionRequest,
    }),
  )

  // The session's stored mode is a vendor-native ModeToken; resolve it to the
  // neutral grid through THIS run's vendor catalog (2026-06-07-012). A token from
  // another vendor (e.g. a project defaultMode set under claude, now launching
  // a future driver vendor) degrades to the launching vendor's defaultToken grid — one knob,
  // every vendor.
  // For codex sessions with a stored CodexPolicy (2026-06-08), use the dual-policy
  // grid directly instead of going through the catalog token.
  // For intent sessions, the read-only gate overrides the session mode.
  // Codex has no live approval channel, so `always-ask` would ask a question no
  // c3 can answer and can prevent its MCP tools from being used. Keep Codex in a
  // read-only sandbox, but let it call the c3 MCP tools; `save_intents` still
  // raises c3's own confirmation inside the MCP handler.
  const mode: {
    actionMode: import('@ccc/shared/protocol').ActionMode
    toolGate: import('@ccc/shared/protocol').ToolGate
  } = intentProfile
    ? intentDriverModeForVendor(adapter.vendor)
    : specProfile
      ? specDriverModeForVendor(adapter.vendor)
      : adapter.vendor === 'codex' && rt.codexPolicy
        ? codexPolicyToGrid(rt.codexPolicy)
        : tokenToGrid(MODE_CATALOGS[adapter.vendor], rt.mode)
  const { actionMode, toolGate } = mode

  // Resolve the session agent's launch overrides (provider connection only). The
  // claude-hardwired path applies these to the SDK; the driver path threads the
  // neutral subset the vendor's driver understands (2026-06-06-007). Codex's policy
  // gate is derived from `actionMode`/`toolGate` in its driver (2026-06-06-008).
  const { agentId, model, envOverrides, relayCandidates } = resolveSessionLaunch(runId)

  // gh stores its token in the OS keyring, which codex's sandbox can't read — so
  // `gh` inside a codex session fails auth even on an authenticated host with
  // network. Bridge the host credential in as `GH_TOKEN` (gh prefers env over the
  // keyring); under arapuca the keyring dir stays deny-by-default, so the env
  // bridge is still needed. A no-op when a token is already set or the host probe
  // fails, and skipped entirely for claude.
  const ghBridgedEnv =
    adapter.vendor === 'codex' ? await resolveCodexGhTokenEnv(envOverrides) : envOverrides
  // Cross-mode resume: a codex session frozen to the sandbox store (ADR-0015) has
  // its rollout under the persistent sandbox CODEX_HOME. Resumed in a NON-sandbox
  // run it would otherwise get host `~/.codex` and fail `no rollout found`. Point
  // CODEX_HOME at that frozen sandbox home so the host process can resume it —
  // safe, as the sandbox home holds no host credentials. A sandbox run already
  // gets its CODEX_HOME from the wrapper; the reverse case (a host-frozen session
  // resumed under sandbox) keeps the wrapper's sandbox home — an accepted limit.
  const crossModeCodexHome =
    adapter.vendor === 'codex' && !rt.sandboxPaths && resolveSessionStoreScope(runId) === 'sandbox'
      ? getSandboxCodexHome(workspacePath)
      : undefined
  const driverEnvOverrides = crossModeCodexHome
    ? { ...(ghBridgedEnv ?? {}), CODEX_HOME: crossModeCodexHome }
    : ghBridgedEnv

  // Sandbox wrapper: when the run has a resolved arapuca allow set, wrap the
  // vendor CLI in `arapuca run -v … -- <cli> "$@"`. The adapter uses this path
  // instead of default host binary resolution. No env-file: the driver spawns the
  // wrapper with a full env (codexExecEnv — process.env + overrides + CODEX_API_KEY
  // from apiKey), which the arapuca child inherits. baseUrl/model ride the
  // wrapper's "$@" argv; the codex RELAY token flows in as CODEX_API_KEY too.
  // `allowKeychain` comes from THIS run's actually-bound agent (`agentId` above):
  // a subscription (`system`-mode) agent authenticates through the host keychain,
  // which arapuca only exposes when explicitly allowed; a custom agent keeps the
  // env-injected credential and no keychain access.
  const sandboxWrapperPath = rt.sandboxPaths
    ? createSandboxWrapper(rt.sandboxPaths, adapter.vendor, rt.sandboxTmpDir ?? '', {
        allowKeychain: resolveAgent(agentId).configMode === 'system',
      })
    : undefined
  // Override cwd: Codex spec sessions (specs root write boundary), effectiveCwd
  // (worktree isolation — also the arapuca same-path cwd), or original workspacePath.
  const specDriverCwd =
    rt.sessionKind === 'spec' && adapter.vendor === 'codex'
      ? getSpecsBase(workspacePath)
      : undefined
  if (specDriverCwd) {
    try {
      mkdirSync(specDriverCwd, { recursive: true })
    } catch (err) {
      throw new Error(`[c3] Codex spec session cannot create specs root: ${errMsg(err)}`, {
        cause: err,
      })
    }
  }
  const driverCwd = specDriverCwd ?? rt.effectiveCwd ?? workspacePath

  // c3 tools over the loopback streamable-HTTP MCP route — the SINGLE transport
  // both Claude and Codex now consume (no vendor branch selects the c3 transport).
  // The active profile's `bindMcp` mints a per-run token, stands up the private MCP
  // server for this run's tool face (intent find/view/save, spec find/view, or work
  // `publish_event`), and returns the neutral descriptors + a `dispose` evicted in
  // `finally`. `getRunId` reads the live `runId` so a pending→real rebind routes the
  // save gate's `permission_request` to the bound session, not the stale pending id.
  // A run is exactly one of intent / session / spec, so at most one binder fires.
  let disposeDriverMcp: () => void = () => {}
  let driverMcpServers: Record<string, RemoteMcpServer> | undefined
  const activeMcpBinder = intentProfile?.bindMcp ?? sessionProfile?.bindMcp ?? specProfile?.bindMcp
  if (activeMcpBinder) {
    const bound = activeMcpBinder({
      workspacePath: workspacePath,
      getRunId: () => runId,
      signal: cycleAbort.signal,
    })
    driverMcpServers = bound.servers
    disposeDriverMcp = bound.dispose
  }

  try {
    const run = await adapter.driver.start({
      prompt: userTurn,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      cwd: driverCwd,
      // The registered root — the Claude driver reads consensus config / attributes
      // audit off this, not the effective (worktree/sandbox) driverCwd above.
      workspacePath,
      signal: cycleAbort.signal,
      actionMode,
      toolGate,
      ...(model ? { model } : {}),
      ...(relayCandidates ? { relayCandidates } : {}),
      ...(driverEnvOverrides ? { envOverrides: driverEnvOverrides } : {}),
      ...(sandboxWrapperPath ? { sandboxWrapperPath } : {}),
      ...(adapter.vendor === 'codex'
        ? { additionalDirectories: [getSpecsBase(workspacePath)] }
        : {}),
      ...(driverMcpServers ? { mcpServers: driverMcpServers } : {}),
      // Work & intent sessions are interactive, user-driven runs that must be able
      // to reach the network (web search/fetch + sandboxed command network access).
      // Codex denies both by default; claude ignores these flags and governs
      // network via their tool allowlist (2026-06-15). Scheduled runs do NOT pass
      // through here — they stay config-gated by toolAllowlist (dispatcher.ts).
      networkAccess: true,
      webSearch: true,
      // A pending session starts fresh; a real id resumes that native session.
      ...(runId.startsWith(PENDING_SESSION_PREFIX) ? {} : { resume: runId }),
    })

    // Bind pending→real once the native session id resolves.
    // session.create, so this is immediate). Mirrors launchRun's bind so the
    // sidebar/url settle onto the real id.
    const sid = await run.sessionId()
    if (sid !== runId && runId.startsWith(PENDING_SESSION_PREFIX)) {
      const prev = runId
      bindPending(prev, sid)
      // Freeze the session→agent fact onto the agent that ran, pinning its vendor
      // AND transcript store scope for the session's life (ADR-0015). A sandbox
      // run wrote into the sandbox vendor data root, so freeze `sandbox` — EXCEPT a
      // system-mode codex, whose sandbox run authenticates from and writes into the
      // HOST ~/.codex (see `codexSystemMode` in createSandboxWrapper), so its store
      // is `host` even under the sandbox.
      const codexSystemRun =
        adapter.vendor === 'codex' && resolveAgent(agentId).configMode === 'system'
      freezeSessionAgent(
        prev,
        sid,
        agentId,
        workspacePath,
        rt.sandboxPaths && !codexSystemRun ? 'sandbox' : 'host',
      )
      runId = sid
      eventBus.publish('run:bound', { prevId: prev, realId: sid, workspacePath })
    }

    const emitter = new WireEmitter((m) => emit(runId, m))
    for await (const msg of run.messages()) {
      if (cycleAbort.signal.aborted) break
      emitter.consume(msg)
    }
    if (!cycleAbort.signal.aborted) emit(runId, { type: 'turn_end', reason: 'complete' })
  } catch (err) {
    settledReason = 'error'
    const message = errMsg(err)
    console.error(
      `[c3] ${adapter.vendor} driver run failed before settle ` +
        `(session=${runId}, workspace=${workspacePath}): ${message}`,
    )
    if (isDegradableError(message)) {
      const agent = resolveAgent(agentId)
      eventBus.publish(
        'agent:error',
        agentErrorEvent({
          sessionId: runId,
          workspacePath,
          agentId: agent.id,
          agentName: agent.displayName,
          error: message,
          degradable: true,
        }),
      )
    }
    if (!cycleAbort.signal.aborted) {
      emit(runId, { type: 'turn_end', reason: 'error', error: message })
    }
  } finally {
    disposeApproval()
    disposeDriverMcp() // evict the per-run c3 HTTP MCP token binding.
    if (rt.run) rt.run = null
    // The driver path is non-Claude. Agent-teams are Claude-locked
    // (2026-06-06-006): no non-Claude vendor has `streamingPush`, so this path never
    // detects a team tool and never wires `onTeam` — a driver session can never be a
    // team. Force the flag false defensively (a team lead can only live on the
    // runClaude path's resident process).
    rt.team = false
    clearPending(runId)
    finalizeRun(runId)
    const reason: RunEndReason = cycleAbort.signal.aborted ? 'aborted' : settledReason
    eventBus.publish('run:settled', {
      sessionId: runId,
      workspacePath,
      reason,
      sessionKind: rt.sessionKind,
      runKind: rt.runKind,
    })
  }
}
