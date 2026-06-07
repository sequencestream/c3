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
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { runClaude } from '../agent/index.js'
import type { VendorAdapter } from '../agent/adapters/types.js'
import { canFormTeam } from '../agent/adapters/capabilities.js'
import { runViaDriver } from './run-via-driver.js'
import { decideResume, type RunOutcome } from './decide-resume.js'
import { buildAgentsToTry } from './build-chain.js'
import {
  getDegradationChain,
  resolveSessionLaunch,
  resolveAgent,
  launchForAgent,
  freezeSessionAgent,
} from '../agent-config/index.js'
import { getSocketAutoResume } from '../config/index.js'
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
  broadcastIntents: (projectPath: string) => void
  /**
   * Intent comm-agent launch profile (read-only gate + disallowed-tools lock
   * + comm system prompt + `save_intents` MCP tool), injected at the
   * composition root so the kernel launcher never imports `features/` (ADR-0009
   * R1). Only consulted for `rt.kind === 'intent'` runtimes; omitted for
   * plain/dev runs. A intent runtime launched without it throws (a missing
   * composition-root wiring is a bug, never a silent drop of the security lock).
   */
  intentProfile?: (workspacePath: string) => {
    appendSystemPrompt: string
    disallowedTools: string[]
    mcpServers: Record<string, McpServerConfig>
    gate: 'intent'
  }
  /**
   * The OpenCode {@link VendorAdapter} (built at the composition root over a
   * started supervisor), or null/absent when OpenCode is unavailable. `launchRun`
   * forks to the neutral {@link runViaDriver} path when the session's vendor is
   * `opencode` (2026-06-06-003); the claude path is untouched. Injected here so the
   * kernel launcher never builds the adapter or imports the supervisor itself.
   */
  getOpencodeAdapter?: () => VendorAdapter | null
  /**
   * The Codex {@link VendorAdapter} (built at the composition root via the no-arg
   * factory, host-binary gated), or null/absent when Codex's host CLI is missing.
   * `launchRun` forks to {@link runViaDriver} when the session's vendor is `codex`
   * (2026-06-06-007), so Codex can be a primary session driver — its launch-time
   * sandbox/approval policy is the per-tool-approval substitute (008).
   */
  getCodexAdapter?: () => VendorAdapter | null
  /**
   * Skill mount step — mount external skill repos into vendor discovery dirs
   * before the run starts (mount layer 2/3, ADR-0017). Pure function; a `false`
   * `ok` means a mount failed (the run still starts, skills degrade to the
   * subset of what mounted). When absent (pre-2/3 or no external skills configured)
   * the step is silently skipped.
   */
  skillMount?: (rt: SessionRuntime) => Promise<SkillMountStep>
}

/** Connection-injected callback the launcher fires. The shape itself is the
 * sealed-union `RunDomainEvent` (see `kernel/types.ts`); this module re-exports
 * it so the seam tests / callers that imported it from here keep working. */
import type { LaunchCbs } from '../types.js'
export type { LaunchCbs } from '../types.js'
import type { SkillMountOutcome } from '../skill-loader/index.js'

/** Outcome of the pre-launch skill mount step, for telemetry / UI status. */
export interface SkillMountStep {
  ok: boolean
  outcome?: SkillMountOutcome
  error?: string
}

/**
 * Shared run launcher. Owns only registry/emit concerns: abort wiring, the prompt
 * echo, status flips, the SDK run, and pending→real id binding. Everything
 * connection-specific (session_started, `viewing`, `activeSessionId`, session-list
 * refresh) is injected via the callbacks, so background launches
 * (`start_development`) and seeded launches (`refine_intent`) can reuse it.
 * Intent runtimes get the read-only gate, the disallowed-tools lock, the comm
 * system prompt, the `save_intents` MCP tool (via `deps.intentProfile`),
 * and a forced `default` permission mode (so `canUseTool` always fires).
 */
export async function launchRun(
  rt: SessionRuntime,
  prompt: string,
  deps: LaunchRunDeps,
  cbs: LaunchCbs = {},
): Promise<void> {
  const workspacePath = rt.workspacePath
  let runId = rt.sessionId
  const isIntent = rt.kind === 'intent'
  // A intent runtime MUST carry the injected read-only profile (its security
  // lock). A missing wiring is a composition-root bug — fail loud, never silently
  // launch a intent agent without its gate / disallowed-tools lock (C-SEC).
  if (isIntent && !deps.intentProfile) {
    throw new Error(
      '[c3] launchRun: a intent runtime requires deps.intentProfile (composition-root wiring missing)',
    )
  }

  // Pre-launch skill mount (mount layer 2/3, ADR-0017): mount external skill repos
  // into vendor discovery dirs before the run starts. Mount failures degrade
  // skills silently (worst case: subset unavailable = indistinguishable from no
  // external skills). If any skills were mounted, the supply-chain write guard
  // (`skillWriteGuard`) is enabled for this run's permission gateway.
  let skillMountStep: SkillMountStep | undefined
  if (deps.skillMount) {
    try {
      skillMountStep = await deps.skillMount(rt)
    } catch (err) {
      console.warn('[c3] skill mount error (non-fatal):', err)
    }
  }
  const hasMountedSkills = skillMountStep?.ok && (skillMountStep.outcome?.mounted.length ?? 0) > 0

  // Vendor fork (2026-06-06-003 / -007): an `opencode` or `codex` session runs
  // through the neutral AgentDriver path, NOT the claude-hardwired loop below (which
  // stays unchanged). intent runtimes are always the claude comm agent, so they
  // never fork. `system`/`claude` vendors fall through to the claude path.
  if (!isIntent) {
    const vendor = resolveAgent(resolveSessionLaunch(runId).agentId).vendor
    if (vendor === 'opencode' || vendor === 'codex') {
      const adapter = vendor === 'opencode' ? deps.getOpencodeAdapter?.() : deps.getCodexAdapter?.()
      if (adapter) return runViaDriver(rt, prompt, adapter, cbs)
      const unavailable =
        vendor === 'opencode'
          ? 'OpenCode is unavailable (host CLI missing, or start c3 with --opencode-url).'
          : 'Codex is unavailable (host CLI `codex` missing — install it to use a Codex agent).'
      emit(runId, { type: 'user_text', text: prompt })
      emit(runId, { type: 'turn_end', reason: 'error', error: unavailable })
      finalizeRun(runId)
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
          prompt,
          cwd: workspacePath,
          signal: attemptAbort.signal,
          // Intent chats are pinned to `default` so the gateway always runs.
          permissionMode: isIntent ? 'default' : rt.mode,
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
          ...(isIntent
            ? // The intent read-only profile (gate + disallowed-tools lock +
              // comm prompt + save_intents tool) is injected at the
              // composition root so the kernel launcher never imports features/.
              deps.intentProfile!(workspacePath)
            : // Socket auto-resume is for ordinary user sessions only — the
              // intent comm agent is excluded (different lifecycle).
              {
                onSocketDisconnect: (info) => {
                  socketInfo = info
                },
              }),
          send: (m) => emit(runId, m),
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
                  // async). The old `onSessionId` was also fire-and-forget.
                  void cbs.onEvent?.({ kind: 'bound', prevId: prev, realId: sid })
                }
              } else if (!hasBound) {
                // First binding on a non-pending session (e.g. resume flow).
                // This path runs once per launchRun.
                hasBound = true
                void cbs.onEvent?.({ kind: 'bound', prevId: prev, realId: sid })
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
    } else if (!success && !cycleAbort.signal.aborted && !hasDegradation) {
      // Single-attempt (no degradation) failure: the runClaude internal
      // catch already emitted turn_end { error }. This branch covers
      // the case where runClaude threw unexpectedly.
    }

    // Authoritative terminal-state backstop. The run is fully over; guarantee a
    // terminal `turn_end` is broadcast and the session settles to `idle`.
    finalizeRun(runId)
    await cbs.onEvent?.({ kind: 'settled', workspacePath })
  }
}
