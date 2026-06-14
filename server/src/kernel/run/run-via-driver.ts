/**
 * Vendor-neutral run path via {@link AgentDriver} (2026-06-06-003). This is the
 * FIRST run that flows through the neutral adapter interface rather than the
 * claude-hardwired `runClaude` loop — `launchRun` forks here when the session's
 * vendor is `opencode`. It is deliberately the *minimal* driver route (range C):
 * it does NOT reuse the claude path's degradation chain, socket auto-resume FSM,
 * consensus, or intent profile — those are claude-shaped and out of scope for
 * the first non-Claude integration. The claude path stays byte-for-byte unchanged.
 *
 * Two translations live here:
 *  - **approval** — the driver's {@link ApprovalBridge} handler is wired to c3's
 *    existing browser approval registry (`permission_request` wire frame +
 *    `waitForDecision`), so an OpenCode permission prompt reaches the same UI a
 *    Claude one does.
 *  - **canonical → wire** — OpenCode streams append-with-upsert canonical frames;
 *    the c3 wire protocol is claude-shaped incremental append. {@link WireEmitter}
 *    diffs successive frames into `assistant_text` deltas + one-shot `tool_use` /
 *    `tool_result`, so the existing web console renders an OpenCode turn unchanged.
 */
import {
  PENDING_SESSION_PREFIX,
  type RunEndReason,
  type ServerToClient,
  type WaitUserInvolveSource,
} from '@ccc/shared/protocol'
import type {
  ApprovalHandler,
  CanonicalMessage,
  RemoteMcpServer,
  VendorAdapter,
} from '../agent/adapters/types.js'
import type { PermissionRequestCtx } from '../permission/gateway.js'
import { MODE_CATALOGS, tokenToGrid } from '../agent/adapters/index.js'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { codexPolicyToGrid, codexDirectSandboxEnv } from '../agent/adapters/codex/driver.js'
import { freezeSessionAgent, resolveSessionLaunch } from '../agent-config/index.js'
import { waitForDecision } from '../permission/index.js'
import { createSandboxWrapper, sandboxEnvFilePath } from '../sandbox/SandboxLauncher.js'
import { buildChildEnv } from '../infra/child-env.js'
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
 * vendor fork in `launchRun`. Only present for `rt.kind === 'intent'` runtimes.
 */
export interface IntentProfile {
  appendSystemPrompt: string
  disallowedTools: string[]
  /** In-process SDK MCP servers — the CLAUDE path (`createSdkMcpServer`). */
  mcpServers: Record<string, McpServerConfig>
  gate: 'intent'
  /**
   * Driver-path remote MCP (2026-06-12-005). Codex/opencode can't load in-process
   * SDK MCP, so the three intent tools are exposed over c3's localhost HTTP MCP
   * route instead. The composition root binds a per-run token (project + run id +
   * abort signal) and returns the neutral {@link RemoteMcpServer} descriptors plus
   * a `dispose` to evict the binding at run end. Absent ⇒ no remote MCP route
   * (the run gets no intent tools, same as before this change). Only codex
   * consumes it today (opencode injection is a later intent — its MCP is
   * server-level, incompatible with a per-run token URL).
   */
  bindDriverMcp?: (binding: {
    projectPath: string
    getRunId: () => string
    signal: AbortSignal
  }) => { servers: Record<string, RemoteMcpServer>; dispose: () => void }
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

/**
 * Diffs append-with-upsert canonical frames into claude-shaped incremental wire
 * events. Text blocks emit only their new suffix; a tool_use emits once when first
 * seen and its result once it back-fills (D3). Keyed by block id (anonymous text
 * is bucketed under a single key — OpenCode text parts always carry an id).
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
 * OpenCode. Codex's human-involvement is the `save_intents` gate (see save-gate.ts).
 */
export function makeDriverApprovalHandler(deps: {
  getRunId: () => string
  workspacePath: string
  source: WaitUserInvolveSource
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
    // on a codex/opencode session lands in the pending-items panel + badge, not just
    // the active chat. Source is the runtime kind (session / intent).
    deps.onPermissionRequest?.({
      requestId: req.requestId,
      toolName: req.toolName,
      input: req.input,
      sessionId: runId,
      workspacePath: deps.workspacePath,
      source: deps.source,
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
 * `opencode` and `codex` (2026-06-06-007); any future driver-routed vendor reuses it.
 *
 * When `intentProfile` is present (intent comm session), its `appendSystemPrompt`
 * is prepended to the prompt, and `actionMode`/`toolGate` are overridden to reflect
 * the read-only gate (safe for non-Claude vendors that don't natively support the
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
): Promise<void> {
  const workspacePath = rt.workspacePath
  let runId = rt.sessionId

  // Prepend the intent system prompt to the driver prompt so the model
  // receives the comm-agent instructions (read-only gate, intent task).
  const effectivePrompt = intentProfile
    ? `${intentProfile.appendSystemPrompt}\n\n${prompt}`
    : prompt

  emit(runId, { type: 'user_text', text: prompt })

  const cycleAbort = new AbortController()
  rt.run = { abort: cycleAbort, handle: null }
  setStatus(runId, 'running')

  // Terminal reason for the run:settled lifecycle event (ADR-0018). Starts at
  // 'complete'; the catch flips it to 'error'; a user stop (aborted) wins in the
  // finally block. Drives event-triggered schedules' reason filter (2026-06-08).
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
      source: rt.kind === 'intent' ? 'intent' : 'session',
      signal: cycleAbort.signal,
      emit,
      waitForDecision,
      onPermissionRequest,
    }),
  )

  // The session's stored mode is a vendor-native ModeToken; resolve it to the
  // neutral grid through THIS run's vendor catalog (2026-06-07-012). A token from
  // another vendor (e.g. a project defaultMode set under claude, now launching
  // opencode) degrades to the launching vendor's defaultToken grid — one knob,
  // every vendor.
  // For codex sessions with a stored CodexPolicy (2026-06-08), use the dual-policy
  // grid directly instead of going through the catalog token.
  // For intent sessions, the read-only gate overrides the session mode:
  // force 'plan' action (read-only) and 'always-ask' tool gate (every tool
  // prompts). This is the safest combo for the intent comm analyst on a
  // non-Claude driver. When no intentProfile, use the normal mode resolution.
  const mode: {
    actionMode: import('@ccc/shared/protocol').ActionMode
    toolGate: import('@ccc/shared/protocol').ToolGate
  } = intentProfile
    ? { actionMode: 'plan', toolGate: 'always-ask' }
    : adapter.vendor === 'codex' && rt.codexPolicy
      ? codexPolicyToGrid(rt.codexPolicy)
      : tokenToGrid(MODE_CATALOGS[adapter.vendor], rt.mode)
  const { actionMode, toolGate } = mode

  // Resolve the session agent's launch overrides (provider connection only). The
  // claude-hardwired path applies these to the SDK; the driver path threads the
  // neutral subset the vendor's driver understands (2026-06-06-007). Codex's policy
  // gate is derived from `actionMode`/`toolGate` in its driver (2026-06-06-008).
  const { agentId, model, baseUrl, apiKey, envOverrides, wireApi } = resolveSessionLaunch(runId)

  // Sandbox wrapper: when the session has a running sandbox container, create
  // a wrapper script that runs the vendor CLI inside the container. The adapter
  // uses this path instead of the default host binary resolution.
  const vendorBinaryName = adapter.vendor === 'codex' ? 'codex' : 'opencode'
  // Env-file for the sandbox wrapper. Base = the same child env the host path
  // builds (keepalive + process.env + agent env overrides). For a codex DIRECT
  // (wireApi=responses) run the SDK delivers the provider apiKey as the
  // host-process `CODEX_API_KEY`, which `docker exec --env-file` does NOT carry
  // into the container — so mirror it into the env-file here (overriding any host
  // CODEX_API_KEY). baseUrl/model ride the wrapper's "$@" argv natively and need
  // no env translation (ADR-0024). The codex RELAY (wireApi=chat) token is NOT known
  // here — it is minted inside the driver's `register()` — so the driver appends it
  // to this same env-file (via `sandboxEnvFile` below) after minting (ADR-0024 follow-up).
  const sandboxEnv = {
    ...buildChildEnv(envOverrides),
    ...(adapter.vendor === 'codex' ? codexDirectSandboxEnv({ apiKey, wireApi }) : {}),
  }
  const sandboxWrapperPath = rt.sandboxHandle
    ? createSandboxWrapper(rt.sandboxHandle, rt.sandboxTmpDir ?? '', vendorBinaryName, sandboxEnv)
    : undefined
  const sandboxEnvFile =
    rt.sandboxHandle && rt.sandboxTmpDir ? sandboxEnvFilePath(rt.sandboxTmpDir) : undefined
  // Override cwd: sandbox container, effectiveCwd (worktree isolation), or original workspacePath.
  const driverCwd = rt.sandboxHandle ? '/workspace' : (rt.effectiveCwd ?? workspacePath)

  // Intent tools over localhost HTTP MCP (2026-06-12-005). Codex/opencode can't load
  // the in-process SDK MCP claude uses, so the comm-agent's find/view/save tools are
  // exposed via c3's loopback HTTP MCP route, bound to THIS run (project + run id +
  // abort signal). Only codex consumes it today; opencode's MCP is server-level
  // (incompatible with a per-run token URL) and is a later intent. `getRunId`
  // reads the live `runId` so a pending→real rebind routes the save gate's
  // `permission_request` to the bound session, not the stale pending id.
  let disposeDriverMcp: () => void = () => {}
  let driverMcpServers: Record<string, RemoteMcpServer> | undefined
  if (intentProfile?.bindDriverMcp && adapter.vendor === 'codex') {
    const bound = intentProfile.bindDriverMcp({
      projectPath: workspacePath,
      getRunId: () => runId,
      signal: cycleAbort.signal,
    })
    driverMcpServers = bound.servers
    disposeDriverMcp = bound.dispose
  }

  try {
    const run = await adapter.driver.start({
      prompt: effectivePrompt,
      cwd: driverCwd,
      signal: cycleAbort.signal,
      actionMode,
      toolGate,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(wireApi ? { wireApi } : {}),
      ...(envOverrides ? { envOverrides } : {}),
      ...(sandboxWrapperPath ? { sandboxWrapperPath } : {}),
      ...(sandboxEnvFile ? { sandboxEnvFile } : {}),
      ...(driverMcpServers ? { mcpServers: driverMcpServers } : {}),
      // A pending session starts fresh; a real id resumes that native session.
      ...(runId.startsWith(PENDING_SESSION_PREFIX) ? {} : { resume: runId }),
    })

    // Bind pending→real once the native session id resolves (OpenCode mints it at
    // session.create, so this is immediate). Mirrors launchRun's bind so the
    // sidebar/url settle onto the real id.
    const sid = await run.sessionId()
    if (sid !== runId && runId.startsWith(PENDING_SESSION_PREFIX)) {
      const prev = runId
      bindPending(prev, sid)
      // Freeze the session→agent fact onto the agent that ran, pinning its vendor
      // for the session's life (ADR-0015).
      freezeSessionAgent(prev, sid, agentId, workspacePath)
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
    if (!cycleAbort.signal.aborted) {
      emit(runId, { type: 'turn_end', reason: 'error', error: errMsg(err) })
    }
  } finally {
    disposeApproval()
    disposeDriverMcp() // evict the per-run intent-MCP token binding (2026-06-12-005).
    if (rt.run) rt.run = null
    // The driver path is non-Claude (opencode / codex). Agent-teams are Claude-locked
    // (2026-06-06-006): no non-Claude vendor has `streamingPush`, so this path never
    // detects a team tool and never wires `onTeam` — a driver session can never be a
    // team. Force the flag false defensively (a team lead can only live on the
    // runClaude path's resident process).
    rt.team = false
    clearPending(runId)
    finalizeRun(runId)
    const reason: RunEndReason = cycleAbort.signal.aborted ? 'aborted' : settledReason
    eventBus.publish('run:settled', { sessionId: runId, workspacePath, reason, kind: rt.kind })
  }
}
