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
import type { PermissionMode, PromptImage, VendorId } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { runClaude } from '../agent/index.js'
import type { VendorAdapter } from '../agent/adapters/types.js'
import { canFormTeam } from '../agent/adapters/capabilities.js'
import {
  runViaDriver,
  type IntentProfile,
  type ResearchProfile,
  type SessionMcpProfile,
  type SpecProfile,
  type SpecReviewProfile,
  type RobotProfile,
} from './run-via-driver.js'
import { modelUserTurn, type RunInject } from './prompt-delivery.js'
import { decideResume, type RunOutcome } from './decide-resume.js'
import { buildAgentsToTry } from './build-chain.js'
import { agentErrorEvent, agentFallbackEvent, agentAllFailedEvent } from './agent-events.js'
import { logRunFailure, type RunLogIdentity } from './run-log.js'
import type { EventBus, EventBusEvents } from '../events/event-bus.js'
import { freezeRobotRoot } from '../permission/index.js'
import type { ConsensusAutoCtx, PermissionRequestCtx } from '../permission/index.js'
import {
  getDegradationChain,
  resolveSessionLaunch,
  resolveAgent,
  launchForAgent,
  freezeSessionAgent,
  bindClaudeRelay,
  unbindRelay,
  usesVendorLogin,
  isModelProviderPausedError,
} from '../agent-config/index.js'
import { getSocketAutoResume, getProjectSandbox } from '../config/index.js'
import { launchSandbox, sandboxEligible, SandboxLaunchError } from '../sandbox/SandboxLauncher.js'
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
   * Spec-REVIEW launch profile (strictly read-only gate + disallowed-tools lock +
   * review system prompt + the reviewer's MCP tools), injected at the composition
   * root so the kernel launcher never imports `features/` (ADR-0009 R1). Consulted
   * ONLY for `rt.sessionKind === 'spec_review'` runtimes. The reviewed intent and
   * the judged fingerprint come off the runtime and are baked into the profile
   * here, so the review's submit tool is bound to one intent and one document
   * version. A review runtime launched without the profile — or without those two
   * facts — throws: a missing wiring is a bug, never a silently unbound reviewer.
   */
  specReviewProfile?: (
    workspacePath: string,
    intentId: string,
    fingerprint: string,
  ) => SpecReviewProfile
  /**
   * IM chat-robot launch profile (the `robot` gate + disallowed-tools lock + the
   * robot's system prompt + its frozen write allowlist), injected at the
   * composition root so the kernel launcher never imports `features/` (ADR-0009
   * R1). Consulted ONLY for `rt.sessionKind === 'robot'` runtimes. A robot
   * runtime launched without it throws: a missing wiring is a bug, never a
   * silent downgrade of an externally-driven turn into a write-capable run
   * carrying the work session's tool face (ADR-0046).
   */
  robotProfile?: (
    workspacePath: string,
    robotId: string,
    imAuth: SessionRuntime['robotImAuth'],
  ) => RobotProfile
  /**
   * Discussion-research launch profile (read-only `discussion-research` gate +
   * disallowed-tools lock + research system prompt), injected at the composition
   * root so the kernel launcher never imports `features/` (ADR-0009 R1). Consulted
   * ONLY for a runtime carrying the research marker (`rt.researchDiscussionId`) —
   * never for the orchestrator's per-agent discussion sessions. A research-marked
   * runtime launched without it throws: a missing wiring is a bug, never a silent
   * downgrade of a read-only follow-up into a write-capable run.
   */
  researchProfile?: (workspacePath: string) => ResearchProfile
  /**
   * Work-session base MCP profile (`publish_event` + the two workspace-memory
   * tools), injected at the composition root so the kernel launcher never imports
   * `features/` (ADR-0009 R1). Consulted ONLY when `rt.sessionKind === 'work'` —
   * a positive test, never "no other profile matched". Absent ⇒ no work-session
   * MCP at all. Unlike intent/spec, a missing profile is NOT a hard error: these
   * are non-security capabilities, so their absence degrades gracefully rather
   * than blocking the run.
   */
  sessionProfile?: (workspacePath: string) => SessionMcpProfile
  /**
   * The {@link VendorAdapter} for a driver-path vendor (built at the composition
   * root, host-binary gated), or null when that vendor's CLI is missing.
   *
   * Keyed by vendor rather than named per vendor: every vendor whose runs go
   * through {@link runViaDriver} resolves its adapter here, so adding one is
   * wiring a factory at the composition root instead of threading a new
   * `get<Vendor>Adapter` callback through the launcher.
   */
  getDriverAdapter?: (vendor: VendorId) => VendorAdapter | null
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
   * Gate for arapuca process-level sandbox isolation. When `sandboxEnabled` is
   * true (or absent → treated as enabled), `launchRun` wraps the vendor CLI in
   * arapuca for any run whose workspace enabled the sandbox and whose
   * `sessionKind` is in the workspace `sandboxSessionKinds` allowlist (source and
   * git branch mode do not matter). When false, runs proceed on the host unchanged.
   */
  sandboxEnabled?: boolean
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
  const isSpecReview = rt.sessionKind === 'spec_review'
  const isRobot = rt.sessionKind === 'robot'
  // The research marker, NOT `sessionKind === 'discussion'`: the orchestrator's
  // per-agent sessions share that kind and must never pick up the research profile.
  const isResearch = !!rt.researchDiscussionId
  // The work-session tool profile is selected POSITIVELY. Deriving it from "none
  // of the other profiles matched" would hand every future session kind the work
  // tools by default — including the discussion agents whose synthesized opinions
  // must never become persisted workspace facts.
  const isWork = rt.sessionKind === 'work'
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
  // Same loud-throw for a spec-REVIEW runtime, extended to the two facts that
  // bind its submit tool. Launching a reviewer without its read-only lock — or
  // with an unbound submit tool that could conclude about anything — is a
  // composition-root bug, never something to degrade past (C-SEC).
  if (isSpecReview && !deps.specReviewProfile) {
    throw new Error(
      '[c3] launchRun: a spec_review runtime requires deps.specReviewProfile (composition-root wiring missing)',
    )
  }
  if (isSpecReview && (!rt.specReviewIntentId || !rt.specReviewFingerprint)) {
    throw new Error(
      '[c3] launchRun: a spec_review runtime requires rt.specReviewIntentId + rt.specReviewFingerprint',
    )
  }
  // Same loud-throw for a research-marked runtime: a follow-up turn on a discussion's
  // research session MUST carry the read-only gate + disallowed-tools lock. Never
  // launch it as an ordinary (write-capable) run because the wiring is missing (C-SEC).
  if (isResearch && !deps.researchProfile) {
    throw new Error(
      '[c3] launchRun: a research runtime requires deps.researchProfile (composition-root wiring missing)',
    )
  }
  // Same loud-throw for a robot runtime. Launching one without its profile would
  // fall through to the standard gate — an inbound group message would then drive
  // a write-capable run that can also stall on a permission prompt nobody can
  // answer. Both halves of that are exactly what ADR-0046 forbids.
  if (isRobot && !deps.robotProfile) {
    throw new Error(
      '[c3] launchRun: a robot runtime requires deps.robotProfile (composition-root wiring missing)',
    )
  }
  // The robot's identity is what its profile is resolved from; without it there
  // is no configuration to constrain the turn, so there is nothing safe to fall
  // back to.
  if (isRobot && !rt.robotId) {
    throw new Error('[c3] launchRun: a robot runtime requires rt.robotId')
  }
  // The robot's run root, FROZEN to its real path once per turn. A robot runtime's
  // `workspacePath` IS `~/.c3/robots/<name>` (robot-turn.ts), so this real path is
  // the boundary every local file access is judged against — the permission gate,
  // the claude PreToolUse hook, and the process-isolation allow set all share it.
  // A root that cannot be resolved throws HERE, before `run:started` is published,
  // so a turn never starts without an established boundary (spec: 根不可解析则回合
  // 失败关闭).
  const robotRoot = isRobot ? freezeRobotRoot(workspacePath) : undefined

  // 本次 run 的日志身份。`runId` 会在 pending→real 绑定后改写,所以每次取用都重新
  // 读一遍闭包变量,而不是提前算好一份快照。
  const runLogIdentity = (): RunLogIdentity => ({
    sessionId: runId,
    workspacePath,
    sessionKind: rt.sessionKind,
    runKind: rt.runKind,
  })

  // Publish the run-started lifecycle event once per launchRun, before the vendor
  // fork so it covers both the claude path below and the driver path (ADR-0018).
  // sessionId is the current runId (possibly a pending id); event-triggered
  // automations filter `sessionKind === 'work'` so intent comm runs never fire them.
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
  // The reviewed intent + judged fingerprint are baked in here (both guaranteed
  // present by the throw above), so the reviewer's submit tool is bound before a
  // single turn runs.
  const resolvedSpecReviewProfile =
    isSpecReview && deps.specReviewProfile
      ? deps.specReviewProfile(workspacePath, rt.specReviewIntentId!, rt.specReviewFingerprint!)
      : undefined
  const resolvedResearchProfile =
    isResearch && deps.researchProfile ? deps.researchProfile(workspacePath) : undefined
  const resolvedRobotProfile =
    isRobot && deps.robotProfile
      ? deps.robotProfile(workspacePath, rt.robotId!, rt.robotImAuth)
      : undefined
  // Resolve the work-session base MCP profile once (publish_event + the two
  // workspace-memory tools), for `work` sessions only. Both the claude path and
  // the driver path consume it.
  const resolvedSessionProfile =
    isWork && deps.sessionProfile ? deps.sessionProfile(workspacePath) : undefined

  // Sandbox launch (arapuca process-level isolation): the entry condition is the
  // workspace's `enabled` master switch AND this run's `sessionKind` being in
  // `sandboxSessionKinds` (default `['work']`) — never the run's source (Intent /
  // spec / plain) nor whether it has an isolated worktree. The run's actual code
  // directory is `executionRoot = rt.effectiveCwd ?? workspacePath`: an isolated
  // worktree run gets its worktree (rw) + source workspace (ro); a current-branch
  // or no-isolated-cwd run gets the source workspace (rw). When enabled, this is
  // HARD isolation (deny-by-default): a missing arapuca binary, an unsupported
  // platform, or an illegal allow path settles the run as an error — never a
  // bare host run. The sandbox outlives socket disconnects (ADR-0006); its temp
  // dir is removed by `finalizeRun` / `removeRuntime` via `rt.sandboxStop`.
  //
  // The sandbox NEVER changes the run's agent: whatever the normal resolution
  // produced (session binding, else the role entry for this session kind) is what
  // runs, sandboxed or not. A `system`-mode (subscription) agent is fine inside —
  // the wrapper opens the host keychain for it (`--allow-keychain`, arapuca ≥ 0.2.5),
  // so the vendor CLI's own login works. Sandboxing only decides whether that
  // agent's vendor CLI is wrapped.
  {
    const sbCfg = getProjectSandbox(workspacePath)
    const sandboxOn = sandboxEligible({
      sandboxEnabled: deps.sandboxEnabled ?? true,
      sandboxAllowed: deps.sandboxAllowed?.() ?? true,
      config: sbCfg,
      sessionKind: rt.sessionKind,
    })
    if (sandboxOn) {
      // The run's actual code execution directory (worktree, or the source workspace).
      const executionRoot = rt.effectiveCwd ?? workspacePath
      try {
        const sandbox = launchSandbox(workspacePath, executionRoot)
        rt.sandboxPaths = sandbox.paths
        rt.sandboxTmpDir = sandbox.tmpDir
        rt.sandboxStop = async () => sandbox.cleanup()
      } catch (err) {
        // Hard-isolation failure: settle the run as an error and stop. Mirrors the
        // vendor-unavailable early return below so the started→settled invariant holds.
        const uiCode = err instanceof SandboxLaunchError ? err.uiCode : 'launch-failed'
        const error = `[c3] sandbox launch failed (${uiCode}): ${errMsg(err)}`
        logRunFailure(runLogIdentity(), `sandbox:${uiCode}`, err)
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
        return
      }
    }
  }

  // A robot turn is process-isolated by FORCE (spec: 进程边界). The gate + hook
  // adjudicate every local READ TOOL, but a tool the vendor runs with no per-call
  // hook (codex `shell`/`apply_patch`, a future manifest tool) would otherwise
  // reach whatever the bare host process can. So a robot ALWAYS runs inside an
  // arapuca-narrowed process, independent of the workspace sandbox switch and
  // `sandboxSessionKinds`; the allow set is the robot's own run root plus the
  // minimal vendor runtime deps (the same `launchSandbox` the workspace sandbox
  // uses — a robot runtime's workspacePath IS its run root, so the mounts collapse
  // to exactly that). Isolation that cannot be established ends the turn with a
  // safe error, never a bare host run.
  if (isRobot && !rt.sandboxPaths) {
    try {
      const executionRoot = rt.effectiveCwd ?? workspacePath
      const sandbox = launchSandbox(workspacePath, executionRoot)
      rt.sandboxPaths = sandbox.paths
      rt.sandboxTmpDir = sandbox.tmpDir
      rt.sandboxStop = async () => sandbox.cleanup()
    } catch (err) {
      // Hard-isolation failure: settle the run as an error and stop (mirrors the
      // workspace sandbox block above).
      const uiCode = err instanceof SandboxLaunchError ? err.uiCode : 'launch-failed'
      const error = `[c3] robot process isolation failed (${uiCode}): ${errMsg(err)}`
      logRunFailure(runLogIdentity(), `robot-isolation:${uiCode}`, err)
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
      return
    }
  }

  // Vendor fork (2026-06-06-007): a `codex` session runs
  // through the neutral AgentDriver path, NOT the claude-hardwired loop below (which
  // stays unchanged). Intent runtimes previously only ran on the claude path; now
  // they fork to the driver when their bound agent's vendor is codex (2026-06-08).
  // `system`/`claude` vendors fall through to the claude path.
  {
    // A record with no vendor at all predates multi-vendor support, so it can
    // only be claude. This back-compat default is for MISSING data only — a
    // present, known vendor (`cursor`, `codex`) is never folded into it.
    //
    // `resolveSessionLaunch` resolves the SELECTED agent (or group leading
    // member) to launch, and throws `ModelProviderPausedError` when it points at
    // a paused provider (agent-config/index.ts). That must settle the turn the
    // same way `vendor-unavailable` below does — never propagate past `run:started`
    // uncaught, or the run is left started-but-never-settled.
    let vendor: VendorId
    try {
      vendor = resolveAgent(resolveSessionLaunch(runId).agentId).vendor ?? 'claude'
    } catch (err) {
      if (!isModelProviderPausedError(err)) throw err
      const error = errMsg(err)
      logRunFailure(runLogIdentity(), 'provider-paused', error)
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
      return
    }
    // A research session is always bound to a claude agent (the research pass is
    // claude-hardwired), so this can only be reached if that binding was lost. The
    // driver path has no `discussion-research` gate, so running there would silently
    // trade the read-only lock for the vendor's own policy — refuse instead (C-SEC).
    if (vendor !== 'claude' && isResearch) {
      const error =
        '[c3] research session resolved to a non-claude agent — refusing to run without the read-only research gate.'
      logRunFailure(runLogIdentity(), 'research-gate', error)
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
      return
    }
    // Every vendor except claude runs through the neutral driver path; claude
    // keeps its own SDK loop below. A vendor is never allowed to reach that loop
    // by falling off the end of this branch.
    if (vendor !== 'claude') {
      const adapter = deps.getDriverAdapter?.(vendor) ?? null
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
          resolvedSpecReviewProfile,
          resolvedRobotProfile,
        )
      const unavailable = `${vendor} is unavailable (its host CLI is missing or incompatible — install it to use a ${vendor} agent).`
      logRunFailure(runLogIdentity(), `vendor-unavailable:${vendor}`, unavailable)
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
  const { agentsToTry, crossVendorSkipped, pausedSkipped } = buildAgentsToTry(
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
  if (pausedSkipped.length > 0) {
    // The SELECTED agent (firstLaunch, above) already fails loudly when paused —
    // this is only about fallback entries further down the chain, which simply
    // drop out rather than aborting the whole degradation chain (see build-chain.ts).
    console.warn(
      `[c3] degradation chain skipped ${pausedSkipped.length} agent(s) with a paused model provider: ` +
        pausedSkipped.map((a) => `${a.agentId}/${a.vendor}`).join(', '),
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

      // Bind this attempt's candidate list to the loopback relay (ADR-0029): the
      // Claude SDK connects to the relay's anthropic endpoint with a per-run token,
      // and the real provider key stays in the relay — never in the subprocess /
      // sandbox. Null ⇒ system mode (first-party login, own config). The token is
      // released in the `finally` below. A group `_c3_<group>` binds N candidates so
      // the relay fails over across the group's providers within this one attempt.
      const claudeRelay = bindClaudeRelay(agentCfg.relayCandidates)

      try {
        await runClaude({
          prompt: modelPrompt,
          // Images accompany the prompt on every fresh-session attempt (the first
          // try AND each degradation fallback, which re-sends `prompt` into a new
          // SDK session). A socket-reconnect pass resumes the SAME session, whose
          // history already holds the images, so it must NOT resend them.
          ...(images && !reconnecting ? { images } : {}),
          cwd: rt.effectiveCwd ?? workspacePath,
          // The registered root — the gateway reads consensus config and attributes
          // WorkCenter events off this, NOT the effective worktree cwd above.
          workspacePath,
          signal: attemptAbort.signal,
          // Intent chats, spec sessions and research sessions are pinned to
          // `default` so the gateway always runs. This is the claude-hardwired path
          // (vendor === 'claude'), so the session's ModeToken is always a Claude
          // `PermissionMode` (2026-06-07-012).
          permissionMode:
            isIntent || isSpec || isResearch ? 'default' : (rt.mode as PermissionMode),
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
          envOverrides: claudeRelay
            ? { ...agentCfg.envOverrides, ...claudeRelay.envOverrides }
            : agentCfg.envOverrides,
          model: agentCfg.model,
          currentAgentId: agentCfg.agentId,
          // Forward the arapuca allow set so the claude path wraps the CLI in arapuca.
          // `sandboxAllowKeychain` is derived from THIS attempt's agent (degradation
          // may land on a different one): only a subscription (`system`-mode) agent
          // needs the host keychain opened inside the sandbox.
          ...(rt.sandboxPaths
            ? {
                sandboxPaths: rt.sandboxPaths,
                sandboxTmpDir: rt.sandboxTmpDir,
                sandboxAllowKeychain: usesVendorLogin(resolveAgent(agentCfg.agentId)),
              }
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
              : isSpecReview
                ? // The spec-review read-only profile (gate + disallowed-tools lock
                  // + review prompt + the reviewer's bound submit tool). No
                  // `specDir`: a reviewer has no writable location to confine.
                  resolvedSpecReviewProfile!
                : isRobot
                  ? // The IM chat-robot profile (gate + disallowed-tools lock + the
                    // robot prompt). `allowedTools` is renamed to `robotAllowedTools`
                    // here because the SDK-facing options carry gate-scoped names;
                    // `bindMcp` binds exactly the selected c3 MCP tools over the
                    // loopback HTTP MCP route (absent when nothing was selected).
                    {
                      appendSystemPrompt: resolvedRobotProfile!.appendSystemPrompt,
                      disallowedTools: resolvedRobotProfile!.disallowedTools,
                      gate: resolvedRobotProfile!.gate,
                      robotAllowedTools: resolvedRobotProfile!.allowedTools,
                      // The turn's frozen run root — the gate adjudicates every
                      // local file tool against it, and runClaude mounts the
                      // PreToolUse hook on it (the second enforcement point).
                      robotRoot,
                      ...(resolvedRobotProfile!.bindMcp
                        ? { bindMcp: resolvedRobotProfile!.bindMcp }
                        : {}),
                    }
                  : isResearch
                    ? // The discussion-research read-only profile (gate + disallowed-tools
                      // lock + research prompt), re-applied on every follow-up turn so a
                      // resumed research session can still only read.
                      resolvedResearchProfile!
                    : // Socket auto-resume is for ordinary user sessions only — the
                      // intent comm agent is excluded (different lifecycle). A work run's
                      // internal instruction (SDD work contract) rides claude's preset
                      // system append here, so it reaches the model without being echoed.
                      // Work sessions also get the base MCP profile (publish_event +
                      // workspace memory) over the loopback HTTP MCP route; the gate
                      // stays 'standard'.
                      {
                        ...(inject?.systemInstruction
                          ? { appendSystemPrompt: inject.systemInstruction }
                          : {}),
                        ...(resolvedSessionProfile
                          ? { bindMcp: resolvedSessionProfile.bindMcp }
                          : {}),
                        onSocketDisconnect: (info) => {
                          socketInfo = info
                        },
                      }),
          send: (m) => emit(runId, m),
          // Permission-event hook: the session id is a getter because `runId`
          // changes on pending→real bind (onSessionId reassigns it).
          sessionId: () => runId,
          initiatedBySubject: rt.initiatedBySubject ?? null,
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
                // pinning its vendor AND transcript store scope for the session's
                // life (ADR-0015). `rt.sandboxPaths` set ⇒ this run wrote into the
                // sandbox vendor data root, so the transcript lives there — EXCEPT a
                // system-mode codex, whose sandbox run authenticates from and writes
                // into the HOST ~/.codex (see the codex sandbox auth profile), so
                // its store is `host` even under sandbox.
                const codexSystemRun =
                  resolveAgent(agentCfg.agentId).vendor === 'codex' &&
                  usesVendorLogin(resolveAgent(agentCfg.agentId))
                freezeSessionAgent(
                  prev,
                  sid,
                  agentCfg.agentId,
                  workspacePath,
                  rt.sandboxPaths && !codexSystemRun ? 'sandbox' : 'host',
                )
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
        if (claudeRelay) unbindRelay(claudeRelay.token)
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
    // 异常退出必须留下现场:此前这里只把消息发到线上,日志里什么都没有,一个抛
    // 出来的 run 事后无从查起。消息 + stack 都打,再照旧把终态发给客户端。
    logRunFailure(runLogIdentity(), 'launch', err)
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
      // 降级链走尽也是一次异常退出:把每个 agent 的失败原因整条记下来,否则日志里
      // 只剩一条笼统的 `settled reason=error`,查不到是谁、因为什么失败的。
      logRunFailure(
        runLogIdentity(),
        'chain-exhausted',
        `all ${failedAgents.length} agent(s) failed: ` +
          failedAgents.map((a) => `${a.agentId}=${a.error}`).join('; '),
      )
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
      // subscribers react to a fully-failed run (e.g. trigger a automation, audit).
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
    // Classify the terminal reason for event-triggered automations: user stop wins,
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
