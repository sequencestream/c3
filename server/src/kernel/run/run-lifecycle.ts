/**
 * The shared run launcher (server refactor 3/3, ADR-0009 — sunk from `server.ts`).
 *
 * `launchRun` is the single entry every run flows through: the 5 callers (user
 * session, `start_development`, `refine_intent`, the intent comm agent,
 * and the automation `runDevTurn`) all reach it. It owns only registry/emit
 * concerns — abort wiring, the prompt echo, status flips, the degradation chain,
 * the bounded socket auto-resume, and pending→real id binding. Connection-specific
 * effects (session_started, the session-list refresh) are injected via `cbs`; the
 * intent read-only profile (its security lock) is injected via
 * `deps.intentProfile` — both so the kernel launcher never imports
 * `transport/` or `features/` (ADR-0009 R1).
 *
 * The control flow is still the original nested loop (3c-2a is a verbatim move);
 * 3c-2b refactors it onto the pure `decideResume` state machine.
 */
import type { PermissionMode, PromptImage } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { runClaude } from '../agent/index.js'
import type { VendorAdapter } from '../agent/adapters/types.js'
import { canFormTeam } from '../agent/adapters/capabilities.js'
import {
  runViaDriver,
  type IntentProfile,
  type SessionMcpProfile,
  type SpecProfile,
} from './run-via-driver.js'
import { modelUserTurn, type RunInject } from './prompt-delivery.js'
import { decideResume, type RunOutcome } from './decide-resume.js'
import { buildAgentsToTry } from './build-chain.js'
import { agentErrorEvent, agentFallbackEvent, agentAllFailedEvent } from './agent-events.js'
import type { EventBus, EventBusEvents } from '../events/event-bus.js'
import type { ConsensusAutoCtx, PermissionRequestCtx } from '../permission/index.js'
import {
  getDegradationChain,
  resolveSessionLaunch,
  resolveAgent,
  launchForAgent,
  freezeSessionAgent,
  setSessionAgent,
} from '../agent-config/index.js'
import { getSocketAutoResume, getProjectSandbox } from '../config/index.js'
import { launchSandbox } from '../sandbox/SandboxLauncher.js'
import { pickSandboxAgent } from './sandbox-agent.js'
import {
  bindPending,
  clearPending,
  emit,
  finalizeRun,
  setStatus,
  type SessionRuntime,
} from '../../runs.js'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Backoff before the single socket-disconnect auto-`resume` (AS-R18 / AVAIL-7):
// 3–5s jittered. Bounded — exactly one such wait per turn (no unbounded retry).
function socketReconnectBackoffMs(): number {
  return 3_000 + Math.floor(Math.random() * 2_000)
}

// Abortable delay: resolves after `ms`, or immediately if the run is stopped.
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Dependencies the launcher reads, injected at the composition root (`server.ts`)
 * so the kernel launcher stays free of any `transport/` or `features/` import
 * (ADR-0009 R1). `broadcastStatuses` re-broadcasts the session-status snapshot on
 * a pending→real bind; `broadcastIntents` is closed over by the intent
 * MCP tool; `intentProfile` carries the intent comm agent's read-only
 * launch profile (see below).
 */
export interface LaunchRunDeps {
  broadcastStatuses: () => void
  broadcastIntents: (workspacePath: string) => void
  /**
   * The kernel event bus (ADR-0018). `launchRun` publishes `'run:bound'` and
   * `'run:settled'` on this bus instead of calling a per-call `onEvent` callback.
   * Consumers subscribe to the bus via `KernelContext.eventBus`.
   */
  readonly eventBus: EventBus<EventBusEvents>
  /**
   * Intent comm-agent launch profile (read-only gate + disallowed-tools lock
   * + comm system prompt + `save_intents` MCP tool), injected at the
   * composition root so the kernel launcher never imports `features/` (ADR-0009
   * R1). Only consulted for `rt.sessionKind === 'intent'` runtimes; omitted for
   * plain/dev runs. A intent runtime launched without it throws (a missing
   * composition-root wiring is a bug, never a silent drop of the security lock).
   */
  intentProfile?: (workspacePath: string, sessionId: string) => IntentProfile
  /**
   * Spec-authoring launch profile (write-confined gate + disallowed-tools lock +
   * spec system prompt), injected at the composition root so the kernel launcher
   * never imports `features/` (ADR-0009 R1). Only consulted for `rt.sessionKind
   * === 'spec'` runtimes. A spec runtime launched without it throws (a missing
   * composition-root wiring is a bug, never a silent drop of the write lock).
   */
  specProfile?: (workspacePath: string) => SpecProfile
  /**
   * Work-session base MCP profile (`publish_pr_event`), injected at the
   * composition root so the kernel launcher never imports `features/` (ADR-0009
   * R1). Consulted ONLY for `rt.sessionKind === 'work'` runs — every new and resumed
   * work session gets the publish tool. Absent ⇒ no work-session MCP (a plain run
   * with no PR-event tool, the pre-2026-06-20 behaviour). Unlike intent/spec, a
   * missing profile is NOT a hard error: the publish tool is a non-security
   * capability, so its absence degrades gracefully rather than blocking the run.
   */
  sessionProfile?: (workspacePath: string) => SessionMcpProfile
  /**
   * The Codex {@link VendorAdapter} (built at the composition root via the no-arg
   * factory, host-binary gated), or null/absent when Codex's host CLI is missing.
   * `launchRun` forks to {@link runViaDriver} when the session's vendor is `codex`
   * (2026-06-06-007), so Codex can be a primary session driver — its launch-time
   * sandbox/approval policy is the per-tool-approval substitute (008).
   */
  getCodexAdapter?: () => VendorAdapter | null
  /**
   * Read-only probe: does this run's project have ANY installed external skill
   * (a live `_c3_<id>` link in a public skill dir)? External skills are no longer
   * mounted at launch (2026-06-12) — install is an explicit user action. This zero-
   * network check only decides whether to enable the supply-chain write guard
   * (`skillWriteGuard`). When absent or it resolves `false`, the guard stays off.
   */
  detectMountedSkills?: (rt: SessionRuntime) => Promise<boolean>
  /**
   * Optional callback invoked before a `permission_request` wire frame is sent
   * to the human. Receives the full {@link PermissionRequestCtx} including
   * sessionId and workspacePath. Forwarded through the run lifecycle to the
   * permission gateway. Wired at the composition root (`server.ts`).
   */
  onPermissionRequest?: (ctx: PermissionRequestCtx) => void
  /**
   * Optional callback for consensus auto-resolutions (the `consensus_auto` path).
   * Forwarded to the permission gateway so an automatic decision lands a
   * non-blocking `status: 'auto'` WaitUserInvolveEvent. Wired at the composition
   * root (`server.ts`). Only the claude path raises consensus (codex runs through
   * the driver, which has no gateway), so this only threads the claude branch.
   */
  onConsensusResolved?: (ctx: ConsensusAutoCtx) => void
  /**
   * Sandbox driver and registry for container-based run isolation.
   * When both are present, `launchRun` attempts to start a sandbox container
   * before the run (based on the project's sandbox config). When absent or
   * the project's sandbox is disabled, runs proceed on the host unchanged.
   */
  sandboxDriver?: import('../sandbox/SandboxDriver.js').SandboxDriver
  sandboxRegistry?: import('../sandbox/SandboxRegistry.js').SandboxRegistry
  /** Runtime policy hook from the composition root; false suppresses sandbox launch. */
  sandboxAllowed?: () => boolean
}

/**
 * Shared run launcher. Owns only registry/emit concerns: abort wiring, the prompt
 * echo, status flips, the SDK run, and pending→real id binding. Connection-specific
 * effects (session_started, `viewing`, `activeSessionId`, session-list refresh) are
 * published on the kernel event bus (ADR-0018) — subscribe to `'run:bound'` and
 * `'run:settled'` via `deps.eventBus` — so background launches (`start_development`)
 * and seeded launches (`refine_intent`) can reuse it.
 * Intent runtimes get the read-only gate, the disallowed-tools lock, the comm
 * system prompt, the `save_intents` MCP tool (via `deps.intentProfile`),
 * and a forced `default` permission mode (so `canUseTool` always fires).
 */
export async function launchRun(
  rt: SessionRuntime,
  prompt: string,
  deps: LaunchRunDeps,
  /**
   * Images attached to this user turn (2026-06-16). Threaded to whichever vendor
   * path this run forks to (codex driver or the claude loop); each encodes them
   * its own way. Internal callers (intent/dev prompts) omit it ⇒ a text-only turn.
   */
  images?: PromptImage[],
  /**
   * Non-visible delivery channels for this turn (hide-session-system-instructions):
   * `systemInstruction` rides the vendor system channel, `userTurnPrefix` leads the
   * model user turn (a slash-command dev skill). Both reach the model but are NEVER
   * echoed — only `prompt` (the visible business context) is. Omitted by intent/spec
   * (their internal role rides the injected profile) and by plain chat turns.
   */
  inject?: RunInject,
): Promise<void> {
  const workspacePath = rt.workspacePath
  let runId = rt.sessionId
  const isIntent = rt.sessionKind === 'intent'
  const isSpec = rt.sessionKind === 'spec'
  // The model's user turn: a slash-command dev-skill prefix (when present) + the
  // visible body. The system instruction is delivered separately (claude's preset
  // system append for work runs), so it never appears in the user turn. The client
  // echo below always carries `prompt` (visible) alone.
  const modelPrompt = modelUserTurn(prompt, inject)
  // A intent runtime MUST carry the injected read-only profile (its security
  // lock). A missing wiring is a composition-root bug — fail loud, never silently
  // launch a intent agent without its gate / disallowed-tools lock (C-SEC).
  if (isIntent && !deps.intentProfile) {
    throw new Error(
      '[c3] launchRun: a intent runtime requires deps.intentProfile (composition-root wiring missing)',
    )
  }
  // Same loud-throw for a spec runtime: it MUST carry the write-confined profile
  // (its security lock). Never launch a spec agent without its path-level write
  // gate / disallowed-tools lock (C-SEC).
  if (isSpec && !deps.specProfile) {
    throw new Error(
      '[c3] launchRun: a spec runtime requires deps.specProfile (composition-root wiring missing)',
    )
  }

  // Publish the run-started lifecycle event once per launchRun, before the vendor
  // fork so it covers both the claude path below and the driver path (ADR-0018).
  // sessionId is the current runId (possibly a pending id); event-triggered
  // schedules filter `sessionKind === 'work'` so intent comm runs never fire them.
  deps.eventBus.publish('run:started', {
    sessionId: runId,
    workspacePath,
    sessionKind: rt.sessionKind,
    runKind: rt.runKind,
  })

  // Supply-chain write guard signal (ADR-0017 D5, 2026-06-12): external skills are
  // installed explicitly via the settings panel, NOT mounted here. Launch only does
  // a zero-network read-only probe — if the project has any installed external skill
  // (a live `_c3_<id>` link), enable `skillWriteGuard` for this run's gateway. A
  // configured-but-not-installed skill has no link ⇒ guard stays off (and the skill
  // is genuinely unavailable, so this is correct, not a regression).
  let hasMountedSkills = false
  if (deps.detectMountedSkills) {
    try {
      hasMountedSkills = await deps.detectMountedSkills(rt)
    } catch (err) {
      console.warn('[c3] skill link probe error (non-fatal):', err)
    }
  }

  // Resolve the intent profile once, before the vendor fork, so both the
  // claude path and the driver path can use it.
  const resolvedIntentProfile =
    isIntent && deps.intentProfile ? deps.intentProfile(workspacePath, runId) : undefined
  const resolvedSpecProfile =
    isSpec && deps.specProfile ? deps.specProfile(workspacePath) : undefined
  // Resolve the work-session base MCP profile once (publish_pr_event), for plain
  // work sessions only — never for intent/spec runs (those carry their own
  // profiles). Both the claude path and the driver path consume it (2026-06-20).
  const resolvedSessionProfile =
    !isIntent && !isSpec && deps.sessionProfile ? deps.sessionProfile(workspacePath) : undefined

  // Sandbox launch (ADR-0024): containers serve ONLY the worktree intent-dev run —
  // a run with an isolated `rt.effectiveCwd` (the worktree). A plain chat run has no
  // effectiveCwd and never sandboxes; a current-branch dev run's sandbox config is
  // stripped by normalize (worktree-only), so it falls through too. When the
  // workspace's sandbox is enabled, this is HARD isolation (deny-by-default): an
  // empty agent pool, a deleted/non-claude pick, or a container start failure settles
  // the run as an error — never a bare host run. The container outlives socket
  // disconnects (ADR-0006); it is stopped by `finalizeRun` / `removeRuntime` via
  // `rt.sandboxStop`.
  if (deps.sandboxDriver && deps.sandboxRegistry && rt.effectiveCwd) {
    const sbCfg = getProjectSandbox(workspacePath)
    const sandboxEnabled =
      (deps.sandboxAllowed?.() ?? true) &&
      !!sbCfg?.enabled &&
      !!sbCfg.sandbox &&
      deps.sandboxRegistry.has(sbCfg.sandbox)
    if (sandboxEnabled) {
      // Hard-isolation failure: settle the run as an error and stop. Mirrors the
      // vendor-unavailable early return below so the started→settled invariant holds.
      const failHard = (error: string): void => {
        console.warn(`[sandbox] run hard-failed: ${error}`)
        emit(runId, { type: 'user_text', text: prompt })
        emit(runId, { type: 'turn_end', reason: 'error', error })
        finalizeRun(runId)
        deps.eventBus.publish('run:settled', {
          sessionId: runId,
          workspacePath,
          reason: 'error',
          sessionKind: rt.sessionKind,
          runKind: rt.runKind,
        })
      }
      // Randomly pick one custom agent from the normalized pool; it decides the run's
      // vendor (the container binary) and provider env. The pick resolver also reports
      // the agent's `wireApi` so a codex DIRECT (responses) OR RELAY (chat) custom agent
      // is admitted while a system-login codex (no injected creds) is rejected (ADR-0024
      // + follow-up). No health check / retry — a bad pick hard-fails (user-confirmed
      // random strategy).
      const pick = pickSandboxAgent(sbCfg.agentIds ?? [], (id) => {
        const a = resolveAgent(id)
        return { id: a.id, vendor: a.vendor, wireApi: launchForAgent(a).wireApi }
      })
      if (!pick.ok) {
        failHard(
          pick.reason === 'empty-pool'
            ? '[c3] sandbox is enabled but its agent pool is empty (configure at least one sandbox-capable agent).'
            : pick.reason === 'unavailable'
              ? `[c3] sandbox-selected agent ${pick.agentId} is unavailable (deleted after the config was saved).`
              : pick.reason === 'unsupported-wire'
                ? `[c3] sandbox-selected codex agent ${pick.agentId} is a system-login codex (no injected provider credentials); the sandbox supports custom codex agents — DIRECT (wireApi=responses) and RELAY (wireApi=chat, via host.docker.internal) — but system-login codex is a follow-up (ADR-0024).`
                : `[c3] sandbox-selected agent ${pick.agentId} is not a sandbox-capable vendor (the sandbox supports Claude and custom Codex agents; ADR-0024).`,
        )
        return
      }
      // Pin the picked agent onto this (pending) dev session so every downstream
      // resolveSessionLaunch(runId) — the vendor fork, the agent chain, the SDK
      // launch — resolves to it, and its provider connection flows into the
      // container: claude via env-file (ANTHROPIC_*); codex DIRECT via the wrapper
      // argv (baseUrl/model) plus CODEX_API_KEY in the env-file; codex RELAY via the
      // host.docker.internal relay hop with the per-run token in the env-file (ADR-0024).
      setSessionAgent(runId, pick.agentId)
      try {
        const sandbox = await launchSandbox(
          deps.sandboxDriver,
          deps.sandboxRegistry,
          workspacePath,
          rt.effectiveCwd,
        )
        if (!sandbox) {
          failHard('[c3] sandbox is enabled but the container did not start.')
          return
        }
        rt.sandboxHandle = sandbox.handle
        rt.sandboxTmpDir = sandbox.tmpDir
        rt.sandboxStop = sandbox.stop
      } catch (err) {
        failHard(`[c3] sandbox container launch failed: ${errMsg(err)}`)
        return
      }
    }
  }

  // Vendor fork (2026-06-06-007): a `codex` session runs
  // through the neutral AgentDriver path, NOT the claude-hardwired loop below (which
  // stays unchanged). Intent runtimes previously only ran on the claude path; now
  // they fork to the driver when their bound agent's vendor is codex (2026-06-08).
  // `system`/`claude` vendors fall through to the claude path.
  {
    const vendor = resolveAgent(resolveSessionLaunch(runId).agentId).vendor
    if (vendor === 'codex') {
      const adapter = deps.getCodexAdapter?.()
      if (adapter)
        return runViaDriver(
          rt,
          prompt,
          adapter,
          deps.eventBus,
          resolvedIntentProfile,
          deps.onPermissionRequest,
          images,
          inject,
          resolvedSessionProfile,
          resolvedSpecProfile,
        )
      const unavailable =
        'Codex is unavailable (host CLI `codex` missing — install it to use a Codex agent).'
      emit(runId, { type: 'user_text', text: prompt })
      emit(runId, { type: 'turn_end', reason: 'error', error: unavailable })
      finalizeRun(runId)
      // Keep the started→settled invariant: a vendor-unavailable early return
      // still settled (as an error), so a started event always has a settled twin.
      deps.eventBus.publish('run:settled', {
        sessionId: runId,
        workspacePath,
        reason: 'error',
        sessionKind: rt.sessionKind,
        runKind: rt.runKind,
      })
      return
    }
  }

  // Build the ordered list of agent configs to try (pure `buildAgentsToTry`).
  // Entry 0 is always the session's current agent (bound or default); subsequent
  // entries come from the degradation chain. The chain is **vendor-homogeneous**:
  // a different-vendor fallback cannot carry context (a Claude session cannot
  // `resume` into Codex), so it is skipped, not launched under the wrong vendor
  // (2026-06-06-006).
  const chain = getDegradationChain()
  const firstLaunch = resolveSessionLaunch(runId)
  const firstVendor = resolveAgent(firstLaunch.agentId).vendor
  const { agentsToTry, crossVendorSkipped } = buildAgentsToTry(
    firstLaunch,
    firstVendor,
    chain,
    resolveAgent,
    launchForAgent,
  )
  if (crossVendorSkipped.length > 0) {
    console.warn(
      `[c3] degradation chain skipped ${crossVendorSkipped.length} cross-vendor agent(s) ` +
        `(session vendor: ${firstVendor}; cannot carry context across vendors): ` +
        crossVendorSkipped.map((a) => `${a.agentId}/${a.vendor}`).join(', '),
    )
  }
  const hasDegradation = agentsToTry.length > 1

  // Single AbortController for the entire cycle. When the user hits stop,
  // this is aborted, which cascades to the current attempt via each
  // attempt's per-attempt controller.
  // IMPORTANT: we set rt.run.abort = cycleAbort so stopRun() kills the
  // entire cycle, not just one attempt.
  const cycleAbort = new AbortController()
  rt.run = { abort: cycleAbort, handle: null }

  // Echo the prompt into the stream once (first attempt only).
  emit(runId, { type: 'user_text', text: prompt })

  const failedAgents: Array<{ agentId: string; agentName: string; error: string }> = []
  let success = false
  // True once the first attempt's onSessionId has fired (so retry
  // attempts skip cbs.onSessionId — no duplicate session_started).
  let hasBound = false
  // Turn-scoped: whether this turn has spent its single socket-disconnect
  // auto-`resume` (AS-R18 / AVAIL-7). Bounds the reconnect to exactly one.
  let socketRetryUsed = false

  // Single attempt loop driven by the pure `decideResume` FSM: it folds the old
  // nested loops (degradation-chain stepping + the single socket auto-resume) into
  // one. The imperative shell only runs `runClaude` and applies the chosen action's
  // side effects (emit / registry / status); all branching lives in `decideResume`.
  // `reconnecting` marks a socket-resume pass (re-run the same agent with `resume:`);
  // `justAdvanced` marks a fresh fallback step, gating the between-attempts
  // `agent_failed` so a resume pass never re-announces a failure.
  let attemptIndex = 0
  let reconnecting = false
  let justAdvanced = false
  try {
    while (attemptIndex < agentsToTry.length) {
      if (cycleAbort.signal.aborted) break

      const agentCfg = agentsToTry[attemptIndex]

      // Emit agent_failed for the agent that just failed, right before the next
      // attempt starts — only on a fresh fallback advance, NOT on a socket-resume
      // pass (which re-runs the same agent and must not re-announce a failure).
      if (justAdvanced && failedAgents.length > 0) {
        const prev = failedAgents[failedAgents.length - 1]
        emit(runId, {
          type: 'agent_failed',
          agentId: prev.agentId,
          agentName: prev.agentName,
          error: prev.error,
        })
        justAdvanced = false
      }

      let degraded = false

      // Per-call abort that cascades user stop from the cycle controller.
      const attemptAbort = new AbortController()
      rt.run = { abort: cycleAbort, handle: null }
      const onCycleAbort = (): void => attemptAbort.abort()
      cycleAbort.signal.addEventListener('abort', onCycleAbort, { once: true })

      setStatus(runId, 'running')

      // The socket disconnect verdict for THIS run pass (null ⇒ no disconnect).
      let socketInfo: { error: string; sideEffectPending: boolean } | null = null

      try {
        await runClaude({
          prompt: modelPrompt,
          // Images accompany the prompt on every fresh-session attempt (the first
          // try AND each degradation fallback, which re-sends `prompt` into a new
          // SDK session). A socket-reconnect pass resumes the SAME session, whose
          // history already holds the images, so it must NOT resend them.
          ...(images && !reconnecting ? { images } : {}),
          cwd: rt.effectiveCwd ?? workspacePath,
          signal: attemptAbort.signal,
          // Intent chats (and spec sessions) are pinned to `default` so the
          // gateway always runs. This is the claude-hardwired path (vendor ===
          // 'claude'), so the session's ModeToken is always a Claude
          // `PermissionMode` (2026-06-07-012).
          permissionMode: isIntent || isSpec ? 'default' : (rt.mode as PermissionMode),
          // Reconnect forces `resume: runId` (same SDK session, full context —
          // AS-R18). First attempt resumes an existing session; degradation
          // retries never resume (each gets a fresh SDK session).
          resume: reconnecting
            ? runId
            : attemptIndex === 0
              ? runId.startsWith(PENDING_SESSION_PREFIX)
                ? undefined
                : runId
              : undefined,
          reconnectAttempt: reconnecting,
          envOverrides: agentCfg.envOverrides,
          model: agentCfg.model,
          currentAgentId: agentCfg.agentId,
          // Forward sandbox handle so the SDK spawns the vendor CLI inside the container
          ...(rt.sandboxHandle
            ? { sandboxHandle: rt.sandboxHandle, sandboxTmpDir: rt.sandboxTmpDir }
            : {}),
          ...(isIntent
            ? // The intent read-only profile (gate + disallowed-tools lock +
              // comm prompt + save_intents tool) is injected at the
              // composition root so the kernel launcher never imports features/.
              deps.intentProfile!(workspacePath, runId)
            : isSpec
              ? // The spec write-confined profile (gate + disallowed-tools lock +
                // spec prompt); `specDir` rides on the runtime (per-run). Like
                // intent, excluded from socket auto-resume (one-shot lifecycle).
                { ...deps.specProfile!(workspacePath), specDir: rt.specDir }
              : // Socket auto-resume is for ordinary user sessions only — the
                // intent comm agent is excluded (different lifecycle). A work run's
                // internal instruction (SDD work contract) rides claude's preset
                // system append here, so it reaches the model without being echoed.
                // Work sessions also get the base MCP profile (publish_pr_event)
                // via its in-process binder; the gate stays 'standard' (2026-06-20).
                {
                  ...(inject?.systemInstruction
                    ? { appendSystemPrompt: inject.systemInstruction }
                    : {}),
                  ...(resolvedSessionProfile
                    ? { bindInProcessMcp: resolvedSessionProfile.bindInProcessMcp }
                    : {}),
                  onSocketDisconnect: (info) => {
                    socketInfo = info
                  },
                }),
          send: (m) => emit(runId, m),
          // Permission-event hook: the session id is a getter because `runId`
          // changes on pending→real bind (onSessionId reassigns it).
          sessionId: () => runId,
          onPermissionRequest: deps.onPermissionRequest,
          onConsensusResolved: deps.onConsensusResolved,
          onStart: (h) => {
            if (rt.run) rt.run.handle = h
          },
          onSessionId: (sid) => {
            if (runId !== sid) {
              const prev = runId
              // First binding (pending→real): call bindPending + external cb.
              // Retry binding (already bound): skip bindPending + external cb
              // to avoid duplicate `session_started` on the wire. The new SDK
              // session id is ephemeral — we don't track it for resume.
              if (prev.startsWith(PENDING_SESSION_PREFIX)) {
                bindPending(prev, sid)
                // Freeze the session→agent fact onto the agent that actually ran,
                // pinning its vendor for the session's life (ADR-0015).
                freezeSessionAgent(prev, sid, agentCfg.agentId, workspacePath)
                runId = sid
                if (!hasBound) {
                  hasBound = true
                  // `bound` is fire-and-forget (the SDK callback is sync, so we
                  // can't `await` here without making the whole callback chain
                  // async). Published on the event bus (ADR-0018).
                  deps.eventBus.publish('run:bound', { prevId: prev, realId: sid, workspacePath })
                }
              } else if (!hasBound) {
                // First binding on a non-pending session (e.g. resume flow).
                // This path runs once per launchRun.
                hasBound = true
                deps.eventBus.publish('run:bound', { prevId: prev, realId: sid, workspacePath })
              }
              // If hasBound is already true (retry), skip everything — the
              // runtime keeps its original Map key.
              deps.broadcastStatuses()
            }
          },
          onTeam: () => {
            // The run became a persistent agent team: the lead process now stays
            // alive across turns. Mark the runtime (so `turn_end` holds at `team`
            // and the next prompt feeds the live run), tell the client once, and
            // surface the team status.
            //
            // Agent-teams are **Claude-locked** (2026-06-06-006): the lead needs
            // `streamingPush` (resident across turns + in-process TeamCreate/
            // SendMessage), which only Claude has. The runClaude path is only ever
            // reached by a Claude-vendor session, so this is structurally true; the
            // `canFormTeam` guard is a defensive assertion so a future non-Claude
            // route can never wrongly upgrade a session that cannot host a lead.
            if (!canFormTeam(resolveAgent(agentCfg.agentId).vendor)) {
              console.warn(
                `[c3] team upgrade ignored: agent ${agentCfg.agentId} vendor lacks streamingPush (agent-teams are Claude-locked)`,
              )
              return
            }
            rt.team = true
            emit(runId, { type: 'team_upgraded' })
            setStatus(runId, 'team')
          },
          onDegradableError: (errMsg) => {
            degraded = true
            const agent = resolveAgent(agentCfg.agentId)
            failedAgents.push({ agentId: agent.id, agentName: agent.displayName, error: errMsg })
            // Event-化 bypass (ADR-0018): publish the per-agent failure on the bus
            // so actions beyond the degradation switch can subscribe. This does NOT
            // alter the wire `agent_failed` frame (still emitted only on a fresh
            // fallback advance) nor the control flow. degradable is always true
            // here (the only eventized failure path is the degradable one).
            deps.eventBus.publish(
              'agent:error',
              agentErrorEvent({
                sessionId: runId,
                workspacePath,
                agentId: agent.id,
                agentName: agent.displayName,
                error: errMsg,
                degradable: true,
              }),
            )
          },
          skillWriteGuard: hasMountedSkills,
        })
      } finally {
        cycleAbort.signal.removeEventListener('abort', onCycleAbort)
      }

      // Classify how the attempt ended (user stop wins; then a socket disconnect;
      // then a degradable error; else a clean completion), and let the FSM decide.
      let outcome: RunOutcome
      if (cycleAbort.signal.aborted) {
        outcome = { kind: 'aborted' }
      } else if (socketInfo) {
        const disconnect: { error: string; sideEffectPending: boolean } = socketInfo
        outcome = {
          kind: 'socket',
          error: disconnect.error,
          ctx: {
            autoResumeEnabled: getSocketAutoResume(),
            sideEffectPending: disconnect.sideEffectPending,
            retryAlreadyUsed: socketRetryUsed,
            isPendingSession: runId.startsWith(PENDING_SESSION_PREFIX),
            isTeam: rt.team,
            aborted: cycleAbort.signal.aborted,
          },
        }
      } else if (degraded) {
        outcome = { kind: 'degradable' }
      } else {
        outcome = { kind: 'completed' }
      }
      const action = decideResume({ attemptIndex, chainLength: agentsToTry.length }, outcome)

      if (action.type === 'succeed') {
        success = true
        break
      }
      if (action.type === 'stop') {
        // A refused socket disconnect carries its terminal turn_end and clears the
        // pending prompt; a user stop carries neither (finalizeRun settles it).
        if (action.turnEnd) {
          emit(runId, action.turnEnd)
          clearPending(runId)
        }
        break
      }
      if (action.type === 'exhausted') {
        // The chain is spent — clear any pending prompt from the last failed
        // attempt; the `finally` emits all_agents_failed + the terminal turn_end.
        clearPending(runId)
        break
      }
      if (action.type === 'resume') {
        socketRetryUsed = true
        // Hold the session in `reconnecting` over the bounded backoff so the
        // sidebar shows the transient state; reconcileLiveness won't reap it
        // (it only converges `running`/aborted/idle).
        setStatus(runId, 'reconnecting')
        await sleepAbortable(socketReconnectBackoffMs(), cycleAbort.signal)
        if (cycleAbort.signal.aborted) break
        reconnecting = true
        continue // re-invoke runClaude with resume: runId (same agent)
      }
      // action.type === 'fallback': clear the failed attempt's pending prompt and
      // advance to the next agent. The next iteration's top emits its agent_failed.
      clearPending(runId)
      // Event-化 bypass (ADR-0018): publish the switch on the bus before advancing.
      // `from` is the agent that just failed (last in failedAgents); `to` is the
      // next chain agent. The wire `agent_failed` (emitted at the next iteration's
      // top) and the control flow are unchanged — this is a pure旁路.
      {
        const from = failedAgents[failedAgents.length - 1]
        const to = resolveAgent(agentsToTry[action.nextIndex].agentId)
        if (from) {
          deps.eventBus.publish(
            'agent:fallback',
            agentFallbackEvent({
              sessionId: runId,
              workspacePath,
              from: { agentId: from.agentId, agentName: from.agentName },
              to: { agentId: to.id, agentName: to.displayName },
            }),
          )
        }
      }
      attemptIndex = action.nextIndex
      reconnecting = false
      justAdvanced = true
    }
  } catch (err) {
    emit(runId, { type: 'turn_end', reason: 'error', error: errMsg(err) })
  } finally {
    if (rt.run) rt.run = null
    // The run is fully over (team sessions only reach here on user stop), so the
    // team is no longer live — clear the flag and fall back to idle.
    rt.team = false
    // Drop any still-pending permission prompt: the run is gone, so it can no
    // longer be answered. Clearing keeps a stale id from holding a *future* turn
    // (same runtime, resumed session) at awaiting_permission.
    clearPending(runId)

    // On chain exhaustion: emit terminal failure banner + turn_end error.
    // Skip this if the user stopped the cycle mid-degradation (finalizeRun
    // will emit turn_end { complete } for the stop). The banner also fires when
    // the chain had **no same-vendor** fallback because every configured fallback
    // was a different vendor and got skipped (`crossVendorSkipped`): the single
    // attempt failed and the user deserves to know the cross-vendor candidates
    // were not (and could not be) tried (2026-06-06-006). `failedAgents.length > 0`
    // keeps this to genuine degradable failures (a non-degradable throw kept
    // runClaude's own turn_end and never populated failedAgents).
    const exhausted =
      !success &&
      !cycleAbort.signal.aborted &&
      failedAgents.length > 0 &&
      (hasDegradation || crossVendorSkipped.length > 0)
    if (exhausted) {
      emit(runId, {
        type: 'all_agents_failed',
        agents: failedAgents,
        message: `All ${failedAgents.length} agent(s) failed. Last error: ${failedAgents[failedAgents.length - 1].error}`,
        ...(crossVendorSkipped.length > 0 ? { crossVendorSkipped } : {}),
      })
      emit(runId, {
        type: 'turn_end',
        reason: 'error',
        error: `All agents failed: ${failedAgents[failedAgents.length - 1].error}`,
      })
      // Event-化 bypass (ADR-0018): publish chain exhaustion on the bus, mirroring
      // the wire `all_agents_failed` frame just emitted (which is untouched). Lets
      // subscribers react to a fully-failed run (e.g. trigger a schedule, audit).
      deps.eventBus.publish(
        'agent:all_failed',
        agentAllFailedEvent({
          sessionId: runId,
          workspacePath,
          agents: failedAgents,
          ...(crossVendorSkipped.length > 0 ? { crossVendorSkipped } : {}),
        }),
      )
    } else if (!success && !cycleAbort.signal.aborted && !hasDegradation) {
      // Single-attempt (no degradation) failure: the runClaude internal
      // catch already emitted turn_end { error }. This branch covers
      // the case where runClaude threw unexpectedly.
    }

    // Authoritative terminal-state backstop. The run is fully over; guarantee a
    // terminal `turn_end` is broadcast and the session settles to `idle`.
    finalizeRun(runId)
    // Classify the terminal reason for event-triggered schedules: user stop wins,
    // then a clean success, else an error (a throw, chain exhaustion, or single-
    // attempt failure all land here as 'error').
    const reason: import('@ccc/shared/protocol').RunEndReason = cycleAbort.signal.aborted
      ? 'aborted'
      : success
        ? 'complete'
        : 'error'
    deps.eventBus.publish('run:settled', {
      sessionId: runId,
      workspacePath,
      reason,
      sessionKind: rt.sessionKind,
      runKind: rt.runKind,
    })
  }
}
