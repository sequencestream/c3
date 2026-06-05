import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AutomationStatus,
  Discussion,
  DiscussionMessage,
  ResearchMessage,
  ServerToClient,
} from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { runClaude, REQUIREMENT_DISALLOWED_TOOLS, decideSocketResume } from './claude.js'
import { addWorkspace, getActiveSessionId, listWorkspaces, setSessionMode } from './state.js'
import { listWorkspaceSessions, sessionExists } from './sessions.js'
import {
  resolveSessionLaunch,
  resolveAgent,
  launchForAgent,
  getDegradationChain,
  getSocketAutoResume,
  getDefaultMode,
} from './settings.js'
import {
  addViewer,
  bindPending,
  ensureRuntime,
  listStatuses,
  reconcileLiveness,
  removeViewer,
  setOnStatusChange,
  setStatus,
  finalizeRun,
  stopRun,
  emit,
  clearPending,
  isRunning,
  type SessionRuntime,
  type Viewer,
} from './runs.js'
import { isStoreAvailable, listRequirements } from './requirements/store.js'
import { enrichRunStatus } from './requirements/run-status.js'
import {
  isStoreAvailable as isDiscussionStoreAvailable,
  listDiscussions,
  getDiscussion,
  setDiscussionResearchResult,
} from './discussions/store.js'
import {
  deleteDiscussionRun,
  deleteResearchRun,
  discussionRunSnapshot,
  hasDiscussionRun,
  researchRunSnapshot,
  setDiscussionRun,
  setResearchRun,
  type DiscussionRunControl,
} from './discussions/run-controls.js'
import {
  researchDiscussionContext,
  canAutoStartDiscussion,
  type ResearchStreamItem,
} from './discussions/research.js'
import {
  runDiscussion,
  defaultDiscussionDeps,
  type DispatchStatus,
} from './discussions/orchestrator.js'
import {
  isStoreAvailable as isScheduleStoreAvailable,
  listSchedules,
  getSchedule,
  updateSchedule as updateScheduleStore,
  appendExecutionLog,
  getDueSchedules,
  updateNextRunAt,
  updateExecutionLog,
} from './schedules/store.js'
import { startScheduler, stopScheduler, setExecutionStore } from './schedules/scheduler.js'
import {
  setBroadcast as setApprovalBroadcast,
  startExpiryScanner,
  stopExpiryScanner,
} from './schedules/queue.js'
import { REQUIREMENT_AGENT_PROMPT } from './requirements/prompt.js'
import { createRequirementMcpServer } from './requirements/save-tool.js'
import {
  hasPendingQuestion,
  type AutomationHooks,
  type DevTurnResult,
  type RunDevTurnInput,
} from './requirements/automation.js'
import { STATIC_ASSETS } from './static-embed.js'
import { mimeFor } from './mime.js'
import { type KernelContext, assertNoTransportFields } from './kernel/types.js'
import { dispatch, createBroadcaster, type Conn } from './transport/index.js'
import { registerHandlers } from './features/index.js'

export interface ServerOptions {
  /** Optional seed workspace — added to the registry and made discoverable. */
  projectPath?: string
  port: number
  dev: boolean
}

// Top-level helpers (no closure-captured state). Hoisted out of `startServer` so
// the slice 1/3 golden-standard contract tests can drive `launchRun` directly
// with a fake deps bag — see `LaunchRunDeps` and ADR-0009.
//
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
 * Closure-captured dependencies that `launchRun` reads from its enclosing scope.
 * Hoisted to a top-level `LaunchRunDeps` so the slice 1/3 contract tests can
 * drive `launchRun` end-to-end with a fake deps bag (mock `broadcastStatuses`,
 * mock `broadcastRequirements`). Production wires the real closures from
 * `startServer`. See ADR-0009 (kernel/transport unidirectional boundaries).
 *
 * Slice 2/3 will replace this with a true `AppContext` field; slice 1/3 keeps
 * the shared state in the startServer closure, so callers pass a deps bag at
 * the call site instead of relying on closure capture.
 */
export interface LaunchRunDeps {
  broadcastStatuses: () => void
  broadcastRequirements: (projectPath: string) => void
}

/**
 * Shared run launcher, hoisted out of `startServer` so the slice 1/3
 * golden-standard contract tests (see `server/test/contracts/`) can drive it
 * directly with a fake `LaunchRunDeps`. Owns only registry/emit concerns:
 * abort wiring, the prompt echo, status flips, the SDK run, and
 * pending→real id binding. Everything connection-specific (session_started,
 * `viewing`, `activeSessionId`, session-list refresh) is injected via the
 * callbacks, so background launches (`start_development`) and seeded launches
 * (`refine_requirement`) can reuse it. Requirement runtimes get the read-only
 * gate, the disallowed-tools lock, the comm system prompt, the
 * `save_requirements` MCP tool, and a forced `default` permission mode (so
 * `canUseTool` always fires).
 */
export async function launchRun(
  rt: SessionRuntime,
  prompt: string,
  deps: LaunchRunDeps,
  cbs: {
    onSessionId?: (prevId: string, realId: string) => void
    onSettled?: (workspacePath: string) => void | Promise<void>
  } = {},
): Promise<void> {
  const workspacePath = rt.workspacePath
  let runId = rt.sessionId
  const isRequirement = rt.kind === 'requirement'

  // Build the ordered list of agent configs to try.
  // Entry 0 is always the session's current agent (bound or default).
  // Subsequent entries come from the degradation chain (if configured).
  const chain = getDegradationChain()
  const firstLaunch = resolveSessionLaunch(runId)
  const agentsToTry: Array<{
    agentId: string
    envOverrides?: Record<string, string>
    model?: string
  }> = [firstLaunch]
  if (chain && chain.length > 0) {
    for (const id of chain) {
      // Skip the first agent (already in agentsToTry[0]) and self-references.
      if (id !== firstLaunch.agentId && !agentsToTry.some((a) => a.agentId === id)) {
        const agent = resolveAgent(id)
        agentsToTry.push({ agentId: agent.id, ...launchForAgent(agent) })
      }
    }
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

  try {
    for (let attempt = 0; attempt < agentsToTry.length; attempt++) {
      if (cycleAbort.signal.aborted) break

      const agentCfg = agentsToTry[attempt]

      // Emit agent_failed for the PREVIOUS attempt before starting the next.
      if (attempt > 0 && failedAgents.length > 0) {
        const prev = failedAgents[failedAgents.length - 1]
        emit(runId, {
          type: 'agent_failed',
          agentId: prev.agentId,
          agentName: prev.agentName,
          error: prev.error,
        })
      }

      let degraded = false
      // Socket-disconnect path resolved this attempt (auto-resume succeeded, or a
      // gated/exhausted disconnect emitted its own terminal `turn_end`). A socket
      // disconnect is NOT degradable, so when set we leave the agent loop rather
      // than trying the next agent (AS-R18).
      let socketTerminated = false

      // Inner sub-loop: the normal run plus AT MOST one auto-`resume` pass after a
      // socket disconnect (AS-R18). `socketRetryUsed` (turn-scoped) bounds it to a
      // single retry — no unbounded reconnect billing. `reconnecting` is true only
      // on the resume pass, which forces `resume: runId` to preserve full context.
      for (let reconnecting = false; ; ) {
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
            // Requirement chats are pinned to `default` so the gateway always runs.
            permissionMode: isRequirement ? 'default' : rt.mode,
            // Reconnect forces `resume: runId` (same SDK session, full context —
            // AS-R18). First attempt resumes an existing session; degradation
            // retries never resume (each gets a fresh SDK session).
            resume: reconnecting
              ? runId
              : attempt === 0
                ? runId.startsWith(PENDING_SESSION_PREFIX)
                  ? undefined
                  : runId
                : undefined,
            reconnectAttempt: reconnecting,
            envOverrides: agentCfg.envOverrides,
            model: agentCfg.model,
            currentAgentId: agentCfg.agentId,
            ...(isRequirement
              ? {
                  appendSystemPrompt: REQUIREMENT_AGENT_PROMPT,
                  disallowedTools: REQUIREMENT_DISALLOWED_TOOLS,
                  mcpServers: createRequirementMcpServer(workspacePath, deps.broadcastRequirements),
                  gate: 'requirement' as const,
                }
              : // Socket auto-resume is for ordinary user sessions only — the
                // requirement comm agent is excluded (different lifecycle).
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
                  runId = sid
                  if (!hasBound) {
                    hasBound = true
                    cbs.onSessionId?.(prev, sid)
                  }
                } else if (!hasBound) {
                  // First binding on a non-pending session (e.g. resume flow).
                  // This path runs once per launchRun.
                  hasBound = true
                  cbs.onSessionId?.(prev, sid)
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
              rt.team = true
              emit(runId, { type: 'team_upgraded' })
              setStatus(runId, 'team')
            },
            onDegradableError: (errMsg) => {
              degraded = true
              const agent = resolveAgent(agentCfg.agentId)
              failedAgents.push({ agentId: agent.id, agentName: agent.name, error: errMsg })
            },
          })
        } finally {
          cycleAbort.signal.removeEventListener('abort', onCycleAbort)
        }

        // User stop wins over any reconnect decision.
        if (cycleAbort.signal.aborted) {
          socketTerminated = true
          break
        }
        // No socket disconnect ⇒ normal completion / degradable / internal error;
        // leave the sub-loop and let the agent-loop logic below take over.
        if (!socketInfo) break

        const disconnect: { error: string; sideEffectPending: boolean } = socketInfo
        // Decide: single same-session auto-resume, or refuse → manual continue.
        const decision = decideSocketResume(disconnect.error, {
          autoResumeEnabled: getSocketAutoResume(),
          sideEffectPending: disconnect.sideEffectPending,
          retryAlreadyUsed: socketRetryUsed,
          isPendingSession: runId.startsWith(PENDING_SESSION_PREFIX),
          isTeam: rt.team,
          aborted: cycleAbort.signal.aborted,
        })
        if (decision.action === 'auto-resume') {
          socketRetryUsed = true
          // Hold the session in `reconnecting` over the bounded backoff so the
          // sidebar shows the transient state; reconcileLiveness won't reap it
          // (it only converges `running`/aborted/idle).
          setStatus(runId, 'reconnecting')
          await sleepAbortable(socketReconnectBackoffMs(), cycleAbort.signal)
          if (cycleAbort.signal.aborted) {
            socketTerminated = true
            break
          }
          reconnecting = true
          continue // re-invoke runClaude with resume: runId
        }
        // Refused (gate blocked / switch off / pending id / exhausted resume): emit
        // the gated terminal `turn_end` and stop — finalizeRun settles to idle.
        emit(runId, decision.turnEnd)
        socketTerminated = true
        break
      }

      if (cycleAbort.signal.aborted) break
      // A socket disconnect is terminal for this turn (resumed-OK, or manual-error
      // already emitted) and is never degradable — never try the next agent.
      if (socketTerminated) {
        clearPending(runId)
        break
      }
      if (degraded) {
        // Clear any pending permission prompts from the failed attempt.
        clearPending(runId)
        continue // try next agent
      }

      // Success!
      success = true
      break
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
    // will emit turn_end { complete } for the stop).
    if (!success && hasDegradation && failedAgents.length > 0 && !cycleAbort.signal.aborted) {
      emit(runId, {
        type: 'all_agents_failed',
        agents: failedAgents,
        message: `All ${failedAgents.length} agent(s) failed. Last error: ${failedAgents[failedAgents.length - 1].error}`,
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
    await cbs.onSettled?.(workspacePath)
  }
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // Seed the registry with the CLI-provided workspace (idempotent).
  if (opts.projectPath) addWorkspace(opts.projectPath, Date.now())

  const send = (ws: { send: (d: string) => void }, msg: ServerToClient): void =>
    ws.send(JSON.stringify(msg))

  // Every live connection's deliver callback. The Broadcaster is the single
  // egress over this set (server refactor 2/3b): `broadcast*` builds the frame
  // and funnels delivery through `broadcaster.toAll`, instead of each iterating
  // `connections` inline. Per-run delivery (emit/viewers, ADR-0006) is separate.
  const connections = new Set<Viewer>()
  const broadcaster = createBroadcaster(connections)
  const broadcastStatuses = (): void => {
    const statuses = listStatuses()
    broadcaster.toAll({ type: 'session_status', statuses })
  }
  // Any runtime status change (run start/finish, permission wait) re-broadcasts.
  setOnStatusChange(broadcastStatuses)

  // The requirement runStatus cache + judged-session de-dup + `enrichRunStatus`
  // are feature-private (server refactor 2/3a): they live in
  // `requirements/run-status` now, consumed here only by `broadcastRequirements`.

  // ---- Session-layer status heartbeat ----

  // How often the server broadcasts a full session-status snapshot (edge-triggered
  // events may drop; this is the periodic safety net for client reconciliation).
  const STATUS_HEARTBEAT_MS = 15_000
  // How long a `running` session can be silent before its run is presumed hung and
  // forcefully converged to `idle`. Conservative — long-running tools (build, deploy)
  // emit no intermediate events but finish much faster than this threshold.
  const RUN_STALE_MS = 5 * 60_000
  // `socketReconnectBackoffMs` and `sleepAbortable` were hoisted to top-level
  // (see above) so the slice 1/3 contract tests can drive `launchRun` directly
  // with a fake deps bag. Production callers (inside `startServer`) still use
  // the top-level helpers; no behavioral change.

  setInterval(() => {
    // Reap stale/hung runs before broadcasting, so the snapshot is authoritative.
    reconcileLiveness(Date.now(), RUN_STALE_MS)
    broadcastStatuses()
  }, STATUS_HEARTBEAT_MS)

  // Push a project's requirement list to every connection (the frontend keeps a
  // per-project map and ignores projects it isn't viewing). Used after a save,
  // a status change, or a dev launch. Applies runStatus enrichment so each
  // client sees the reconciled running/dangling/idle state. No-op when the
  // store is unavailable.
  const broadcastRequirements = (projectPath: string): void => {
    if (!isStoreAvailable()) return
    const proj = resolve(projectPath)
    const items = enrichRunStatus(listRequirements(proj))
    broadcaster.toAll({ type: 'requirements', projectPath: proj, items })
  }

  // Push a project's refreshed discussion list to every connection (the frontend
  // keeps a per-project cache and renders the one it's viewing). No-op when the
  // store is unavailable.
  const broadcastDiscussions = (projectPath: string): void => {
    if (!isDiscussionStoreAvailable()) return
    const proj = resolve(projectPath)
    const items = listDiscussions(proj)
    const runStates = discussionRunSnapshot(items)
    const researchStates = researchRunSnapshot(items)
    broadcaster.toAll({ type: 'discussions', projectPath: proj, items, runStates, researchStates })
  }

  // Push a workspace's schedule list to every connection. Used after create,
  // update, delete. No-op when the store is unavailable.
  const broadcastSchedules = (workspacePath: string): void => {
    if (!isScheduleStoreAvailable()) return
    const proj = resolve(workspacePath)
    const items = listSchedules(proj)
    broadcaster.toAll({ type: 'schedules', workspacePath: proj, items })
  }

  // Live discussion/research run controls + their list snapshots are
  // feature-private (server refactor 2/3a): they live in
  // `discussions/run-controls` now, consumed here by the broadcasts + run starters.

  // Stream one freshly-appended discussion message to every connection (the
  // frontend appends it when viewing that discussion).
  const broadcastDiscussionMessage = (discussionId: string, message: DiscussionMessage): void => {
    broadcaster.toAll({ type: 'discussion_message', discussionId, message })
  }

  // Broadcast the transient in-flight/failed status of agents the organizer just
  // dispatched (pending → cleared/failed). Runtime-only, never persisted; maps the
  // engine's per-agent DispatchStatus onto the wire event.
  const broadcastDiscussionDispatchStatus = (discussionId: string, s: DispatchStatus): void => {
    const evt =
      s.phase === 'failed'
        ? {
            type: 'discussion_dispatch_status' as const,
            discussionId,
            phase: 'failed' as const,
            agents: [s.agent],
            error: s.error,
          }
        : {
            type: 'discussion_dispatch_status' as const,
            discussionId,
            phase: s.phase,
            agents: s.agents,
          }
    broadcaster.toAll(evt)
  }

  // Broadcast a discussion's live run-state (decoupled from its persisted status).
  const broadcastDiscussionRunStatus = (
    discussionId: string,
    state: 'running' | 'paused' | 'ended',
  ): void => {
    broadcaster.toAll({ type: 'discussion_run_status', discussionId, state })
  }

  // Stream one research turn to every connection (runtime-only — research messages
  // are never persisted; the frontend appends to the right pane's research stream).
  const broadcastResearchMessage = (discussionId: string, item: ResearchStreamItem): void => {
    const message: ResearchMessage = { ...item, discussionId, createdAt: Date.now() }
    broadcaster.toAll({ type: 'research_message', discussionId, message })
  }

  // Broadcast a discussion's research-run liveness (running while the agent works,
  // ended on finish/fail/dead process). Runtime-only, mirrors discussion_run_status.
  const broadcastResearchRunStatus = (discussionId: string, state: 'running' | 'ended'): void => {
    broadcaster.toAll({ type: 'research_run_status', discussionId, state })
  }

  // The pause gate handed to the engine: resolves at once unless paused, else
  // blocks until resume() wakes the waiters or the run is aborted.
  const makeDiscussionGate =
    (ctrl: DiscussionRunControl) =>
    (signal: AbortSignal): Promise<void> => {
      if (!ctrl.paused || signal.aborted) return Promise.resolve()
      return new Promise<void>((res) => {
        const wake = (): void => res()
        ctrl.resumeWaiters.push(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }

  // Start a background orchestration run for a discussion (shared by
  // `start_discussion` and `continue_discussion`). The caller has already gated
  // re-entry and set the discussion's status; here we register the run control,
  // wire the broadcast + pause hooks, and clean up on finish.
  const startDiscussionRun = (discussion: Discussion): void => {
    const abort = new AbortController()
    const ctrl: DiscussionRunControl = { abort, paused: false, resumeWaiters: [] }
    setDiscussionRun(discussion.id, ctrl)
    broadcastDiscussionRunStatus(discussion.id, 'running')
    const deps = defaultDiscussionDeps({
      onMessage: (m) => broadcastDiscussionMessage(discussion.id, m),
      // Status/conclusion changes ride the refreshed list broadcast.
      onStatusChange: () => broadcastDiscussions(discussion.projectPath),
      onDispatchStatus: (s) => broadcastDiscussionDispatchStatus(discussion.id, s),
      gate: makeDiscussionGate(ctrl),
    })
    // Background orchestration: runs the agents and streams messages until it
    // concludes. It does not own a user session, so finishing never ends a
    // session (既有 session 约定).
    void runDiscussion(discussion.id, abort.signal, deps)
      .catch((err) => {
        console.warn(`[c3] discussion orchestration error: ${errMsg(err)}`)
      })
      .finally(() => {
        deleteDiscussionRun(discussion.id)
        broadcastDiscussionRunStatus(discussion.id, 'ended')
        broadcastDiscussions(discussion.projectPath)
      })
  }

  // Start the read-only research run for a freshly-created discussion as an observable
  // run (mirrors startDiscussionRun): register liveness, broadcast `running`, stream each
  // turn, and on settle persist the result, broadcast `ended`, then auto-start the
  // orchestration on success. Fire-and-forget — research never blocks creation. The
  // `ended`-before-auto-start order means the right pane switches research → discussion in
  // one batch; a failed research broadcasts `ended` without auto-start, surfacing the
  // manual Start fallback.
  const startResearchRun = (discussion: Discussion): void => {
    const abort = new AbortController()
    setResearchRun(discussion.id, abort)
    broadcastResearchRunStatus(discussion.id, 'running')
    broadcastDiscussions(discussion.projectPath)
    void researchDiscussionContext(discussion, {
      onMessage: (item) => broadcastResearchMessage(discussion.id, item),
    })
      .then(({ ok, researchResult }) => {
        // Store the research output in its own field; the user's original `context` is
        // never overwritten. Empty output leaves it as ''.
        if (researchResult) {
          setDiscussionResearchResult(discussion.id, researchResult)
        }
        deleteResearchRun(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        broadcastDiscussions(discussion.projectPath)
        // Research failed → leave it a draft for a manual Start. On success, re-validate
        // on the freshest record (it may have been manually Started or cancelled
        // mid-research) before auto-starting the orchestration.
        if (!ok) return
        const latest = getDiscussion(discussion.id)
        if (canAutoStartDiscussion(latest, hasDiscussionRun(discussion.id))) {
          startDiscussionRun(latest as Discussion)
        }
      })
      .catch((err) => {
        // Defensive: research itself swallows its run error (returns ok=false), so this
        // only fires on a wiring fault. Still converge liveness so the phase doesn't hang.
        deleteResearchRun(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        broadcastDiscussions(discussion.projectPath)
        console.warn(`[c3] discussion research wiring error: ${errMsg(err)}`)
      })
  }

  // Push an automation-orchestrator status to every connection (the frontend
  // keeps a per-project map and renders the one it's viewing).
  const broadcastAutomation = (status: AutomationStatus): void => {
    broadcaster.toAll({ type: 'automation_status', status })
  }

  // `launchRun` is hoisted to top-level (see `export async function launchRun`
  // above `startServer`) so the slice 1/3 contract tests can drive it directly
  // with a fake deps bag. Production callers in `startServer` still call the
  // top-level function with the real closure deps — no behavior change.

  /**
   * Run one dev turn for the automation orchestrator and resolve once it settles.
   * Observes the runtime via an internal viewer: the last assistant text is the
   * "completion message" the judge reads; a `turn_end` resolves complete/error.
   *
   * Automation MIRRORS manual execution on permission prompts: a `permission_request`
   * does NOT abort the run. The prompt is already surfaced to the browser (claude.ts
   * `send`s it before awaiting), the run stays alive in `awaiting_permission`, and a
   * watching human answers it there — exactly like a manual session. We only signal
   * the orchestrator (`onAwaitingPermission`) so it can show an "awaiting authorization"
   * hint; the turn then settles `complete`/`error` once the human responds. Only a real
   * abort (automation stopped) resolves `blocked`. A fresh `sessionId` (null) launches a
   * new dev session; a real id resumes it (the continue continuation) — or feeds a live team
   * lead directly.
   */
  const runDevTurn = (input: RunDevTurnInput): Promise<DevTurnResult> =>
    new Promise<DevTurnResult>((resolveTurn) => {
      const id = input.sessionId ?? `${PENDING_SESSION_PREFIX}${randomUUID()}`
      const rt = ensureRuntime(id, input.projectPath, getDefaultMode(), [], 'normal')
      let lastText = ''
      // Attaching to an already-running turn: its latest assistant text may have
      // been emitted BEFORE we add our viewer, so seed lastText from the buffer —
      // otherwise the completion judge would read '' instead of the real message.
      if (input.attach) {
        for (const e of rt.buffer) if (e.type === 'assistant_text') lastText = e.text
      }
      let settled = false
      let awaiting = false
      const finish = (r: DevTurnResult): void => {
        if (settled) return
        settled = true
        removeViewer(rt.sessionId, viewer)
        resolveTurn(r)
      }
      const viewer: Viewer = (e) => {
        if (e.type === 'assistant_text') {
          lastText = e.text
        } else if (e.type === 'permission_request') {
          // A human authorization is needed. Automation mirrors manual: do NOT abort —
          // the prompt is already surfaced to the browser and the run stays alive
          // awaiting the watching human's answer. Just signal the orchestrator so it
          // can show an "awaiting authorization" hint.
          if (!awaiting) {
            awaiting = true
            input.onAwaitingPermission?.(true)
          }
        } else if (e.type === 'tool_result') {
          // The pending prompt was answered (its tool produced a result) — the run
          // is moving again. Clear the awaiting hint.
          if (awaiting) {
            awaiting = false
            input.onAwaitingPermission?.(false)
          }
        } else if (e.type === 'turn_end') {
          if (awaiting) {
            awaiting = false
            input.onAwaitingPermission?.(false)
          }
          finish({
            outcome: e.reason === 'error' ? 'error' : 'complete',
            sessionId: rt.sessionId,
            lastMessage: lastText,
            detail: e.error,
          })
        }
      }
      addViewer(id, viewer)
      input.signal.addEventListener('abort', () => {
        stopRun(rt.sessionId)
        finish({
          outcome: 'blocked',
          sessionId: rt.sessionId,
          lastMessage: lastText,
          detail: 'aborted',
        })
      })

      // Attach mode: the turn is already running in the background — only observe
      // it (the viewer above), never launch or push. If it settled in the race
      // between the orchestrator's isRunning check and our addViewer, its turn_end
      // already fired (before our viewer existed), so resolve now from the buffer
      // instead of hanging forever.
      if (input.attach) {
        if (!isRunning(rt.sessionId)) {
          let outcome: DevTurnResult['outcome'] = 'complete'
          let detail: string | undefined
          for (let i = rt.buffer.length - 1; i >= 0; i--) {
            const e = rt.buffer[i]
            if (e.type === 'turn_end') {
              outcome = e.reason === 'error' ? 'error' : 'complete'
              detail = e.error
              break
            }
          }
          // The settled turn may have ended on an unanswered AskUserQuestion (a real
          // human decision). It reads as `complete` here, but the orchestrator must
          // stop, not continue over it — flag it so develop()'s guard catches a
          // mis-judged in_progress (RM-A11).
          finish({
            outcome,
            sessionId: rt.sessionId,
            lastMessage: lastText,
            detail,
            pendingQuestion: hasPendingQuestion(rt.buffer),
          })
        }
        return
      }

      // Live team lead (rare for a dev skill): feed the same process. Otherwise launch
      // a new session or resume the existing one.
      if (rt.team && rt.run?.handle) {
        emit(rt.sessionId, { type: 'user_text', text: input.prompt })
        setStatus(rt.sessionId, 'running')
        rt.run.handle.pushInput(input.prompt)
      } else {
        void launchRun(
          rt,
          input.prompt,
          { broadcastStatuses, broadcastRequirements },
          {
            onSessionId: (_prev, sid) => {
              setSessionMode(sid, rt.mode)
              // Surface the bind to the orchestrator immediately (early in_progress flip).
              input.onSessionId?.(sid)
            },
          },
        )
      }
    })

  const automationHooks: AutomationHooks = {
    runDevTurn,
    broadcastRequirements,
    emitStatus: broadcastAutomation,
    sessionExists,
    isRunning,
  }

  // ── Composition root (ADR-0009 R3): construct the KernelContext ONCE,
  // explicitly, and inject it into every handler at dispatch time. It holds the
  // cross-feature services (launcher, broadcasts, run starters, automation hooks);
  // feature-private state now lives in each feature's store (2/3a), and slice 2/3b
  // folds the broadcasts into a single transport/Broadcaster. `launchDeps` is the
  // bag the top-level `launchRun` reads.
  const launchDeps = { broadcastStatuses, broadcastRequirements }
  const ctx: KernelContext = {
    launchDeps,
    launchRun: (rt, prompt, cbs) => launchRun(rt, prompt, launchDeps, cbs),
    broadcastStatuses,
    broadcastRequirements,
    broadcastDiscussions,
    broadcastSchedules,
    broadcastAutomation,
    broadcastDiscussionMessage,
    broadcastDiscussionRunStatus,
    startDiscussionRun,
    startResearchRun,
    automationHooks,
  }
  // R6 boot-time guard: no transport field (sock/viewer/connections) may cross
  // the kernel boundary.
  assertNoTransportFields(ctx)

  // The startup handler registry: an exhaustive `Record<ClientToServer['type'],
  // Handler>` (a missing handler is a compile-time error). The 40+ case switch
  // below collapses to a single `dispatch(reg, ctx, conn, raw)`.
  const handlerRegistry = registerHandlers()

  app.get(
    '/ws',
    upgradeWebSocket(() => {
      // This connection is a *view* onto sessions, not an owner of runs (ADR-0006).
      // Per-connection state (which session it watches + how to deliver) lives on
      // `conn`; shared run state lives in the module-level registry and `ctx`.
      let sock: { send: (d: string) => void } | null = null
      const conn: Conn = {
        send: (msg) => {
          if (sock) send(sock, msg)
        },
        viewing: null,
        deliver: (msg) => {
          if (sock) send(sock, msg)
        },
        sendWorkspaces: () => {
          if (sock) send(sock, { type: 'workspaces', workspaces: listWorkspaces() })
        },
        sendSessions: async (workspacePath) => {
          if (!sock) return
          try {
            const sessions = await listWorkspaceSessions(workspacePath)
            send(sock, { type: 'sessions', workspacePath, sessions })
          } catch (err) {
            send(sock, {
              type: 'error',
              error: { code: 'session.listFailed', params: { detail: errMsg(err) } },
            })
          }
        },
      }

      return {
        onOpen(_evt, ws) {
          sock = ws
          broadcaster.add(conn.deliver)
          send(ws, {
            type: 'ready',
            workspaces: listWorkspaces(),
            activeSessionId: getActiveSessionId(),
            statuses: listStatuses(),
          })
        },
        // The 40+ case switch collapsed to a single registry dispatch (ADR-0009):
        // parse + validate + exhaustive lookup all live in `dispatch`.
        async onMessage(evt) {
          await dispatch(handlerRegistry, ctx, conn, String(evt.data))
        },
        onClose() {
          // Keep runs alive in the background; just stop delivering to this view.
          if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
          broadcaster.remove(conn.deliver)
          sock = null
        },
      }
    }),
  )

  // Serve frontend static (production / pkg). Two sources, in priority order:
  // 1. STATIC_ASSETS — Bun-embedded assets baked into the compiled binary.
  // 2. resolveStaticRoot() — filesystem fallback for `node cli.cjs start`.
  if (!opts.dev) {
    const staticRoot = STATIC_ASSETS.size === 0 ? resolveStaticRoot() : null
    app.get('*', (c) => {
      const path = c.req.path === '/' ? '/index.html' : c.req.path
      const embedded = STATIC_ASSETS.get(path)
      if (embedded) {
        return c.body(embedded.body, 200, { 'content-type': embedded.mime })
      }
      if (staticRoot) {
        const filePath = join(staticRoot, path)
        if (existsSync(filePath)) {
          return c.body(readFileSync(filePath), 200, { 'content-type': mimeFor(path) })
        }
      }
      // SPA fallback → index.html
      const index = STATIC_ASSETS.get('/index.html')
      if (index) {
        return c.body(index.body, 200, { 'content-type': index.mime })
      }
      if (staticRoot) {
        const idx = join(staticRoot, 'index.html')
        if (existsSync(idx)) {
          return c.html(readFileSync(idx, 'utf-8'))
        }
      }
      return c.text('Frontend bundle not found. Did you run `pnpm build` or `pnpm pkg`?', 500)
    })
  } else {
    app.get('/', (c) => c.text('dev mode: open http://localhost:5173'))
  }

  const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
    const url = `http://localhost:${info.port}`
    console.log(`[c3] server running at ${url}`)
    if (opts.projectPath) console.log(`[c3] seed workspace: ${opts.projectPath}`)
    if (opts.dev) console.log(`[c3] dev mode — open Vite at http://localhost:5173`)
  })
  injectWebSocket(server)

  // Start the schedule scheduler after the server is ready.
  if (isScheduleStoreAvailable()) {
    setExecutionStore({
      getDueSchedules,
      getSchedule,
      updateNextRunAt,
      updateSchedule: (id: string, patch: { status?: string }) => {
        updateScheduleStore(id, {
          status: patch.status as import('@ccc/shared/protocol').ScheduleStatus | undefined,
        })
      },
      appendExecutionLog: (input) => {
        return appendExecutionLog({
          scheduleId: input.scheduleId,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          exitCode: input.exitCode,
          output: input.output ?? '',
          error: input.error,
          status: 'running',
        })
      },
      updateExecutionLog,
      broadcast: broadcastSchedules,
    })

    // Wire the write-approval broadcast to all WS connections and start the
    // expiry scanner so overdue approvals auto-reject.
    setApprovalBroadcast((event) => {
      if (event.type === 'pending') {
        const approval = event.approval as import('@ccc/shared/protocol').PendingWriteApproval
        broadcaster.toAll({ type: 'schedule_write_approval_pending', approval })
      } else if (event.type === 'resolved') {
        const r = event.approval as {
          approvalId: string
          status: 'approved' | 'rejected' | 'expired'
          scheduleId?: string
        }
        broadcaster.toAll({
          type: 'schedule_write_approval_resolved',
          approvalId: r.approvalId,
          status: r.status,
          scheduleId: r.scheduleId ?? '',
        })
      }
    })
    startExpiryScanner()

    startScheduler()
  }

  // Graceful shutdown: stop the scheduler on process termination.
  const shutdown = async () => {
    console.log('[c3] shutting down...')
    stopExpiryScanner()
    await stopScheduler(30_000)
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function resolveStaticRoot(): string | null {
  // Filesystem fallback for `node cli.cjs start` (dev / non-pkg deploy).
  // Compiled Bun binaries serve from STATIC_ASSETS instead.
  // `import.meta.url` is wrapped in eval so esbuild's CJS bundle doesn't statically
  // see it (avoids the "import.meta not available with cjs" warning). In the shipped
  // CJS/Bun artifact `__dirname` is always defined, so this branch never runs there;
  // it only serves an ESM dev runtime, where eval still resolves import.meta locally.
  const here =
    typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(String(eval('import.meta.url'))))
  const candidates = [
    resolve(here, '../../web/dist'),
    resolve(here, '../web/dist'),
    resolve(process.cwd(), 'web/dist'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c
  }
  return null
}
