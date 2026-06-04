import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AutomationStatus,
  ClientToServer,
  Discussion,
  DiscussionMessage,
  ResearchMessage,
  Requirement,
  RequirementRunStatus,
  ServerToClient,
} from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import {
  runClaude,
  registerPermissionResolver,
  REQUIREMENT_DISALLOWED_TOOLS,
  decideSocketResume,
} from './claude.js'
import { listCommands } from './commands.js'
import {
  addWorkspace,
  getActiveSessionId,
  getSessionMode,
  hasWorkspace,
  listWorkspaces,
  removeWorkspace,
  setActiveSessionId,
  setSessionMode,
  touchWorkspace,
} from './state.js'
import {
  listWorkspaceSessions,
  loadHistory,
  loadLastAssistantMessages,
  removeSession,
  renameWorkspaceSession,
  sessionExists,
  sessionTitle,
} from './sessions.js'
import {
  loadSettings,
  saveSettings,
  resolveSessionLaunch,
  resolveAgent,
  launchForAgent,
  getDegradationChain,
  getSocketAutoResume,
  getDefaultMode,
  getDevSkill,
} from './settings.js'
import {
  addViewer,
  bindPending,
  ensureRuntime,
  getRuntime,
  listStatuses,
  reconcileLiveness,
  removeRuntime,
  removeRuntimesForWorkspace,
  removeViewer,
  setOnStatusChange,
  setStatus,
  finalizeRun,
  stopRun,
  emit,
  resolvePending,
  clearPending,
  isRunning,
  type SessionRuntime,
  type Viewer,
} from './runs.js'
import {
  getChatSession,
  getRequirement,
  isStoreAvailable,
  listRequirements,
  rebindChatSession,
  setAutomate,
  setChatSession,
  setLastDevSession,
  updateStatus,
} from './requirements/store.js'
import {
  isStoreAvailable as isDiscussionStoreAvailable,
  listDiscussions,
  getDiscussion,
  createDiscussion,
  setDiscussionResearchResult,
  listMessages as listDiscussionMessages,
  appendMessage as appendDiscussionMessage,
  updateDiscussionStatus as updateDiscussionStatus,
} from './discussions/store.js'
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
import { isDiscussionType } from '@ccc/shared/discussion-types'
import {
  isStoreAvailable as isScheduleStoreAvailable,
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule as updateScheduleStore,
  deleteSchedule as deleteScheduleStore,
  getScheduleDetail,
  listExecutionLogs,
  appendExecutionLog,
  getDueSchedules,
  updateNextRunAt,
  updateExecutionLog,
  listPendingWriteApprovals as storeListPendingApprovals,
  getWorkspaceMcpConfig as storeGetWorkspaceMcpConfig,
  saveWorkspaceMcpConfig as storeSaveWorkspaceMcpConfig,
} from './schedules/store.js'
import {
  startScheduler,
  stopScheduler,
  triggerRunNow,
  setExecutionStore,
} from './schedules/scheduler.js'
import { readExecutionTranscript } from './schedules/transcript.js'
import {
  setBroadcast as setApprovalBroadcast,
  startExpiryScanner,
  stopExpiryScanner,
  resolveApproval,
  cancelAllForWorkspace as cancelAllApprovalsForWorkspace,
} from './schedules/queue.js'
import { onWorkspaceRemoved } from './schedules/archiver.js'
import { generateScheduleName } from './schedules/naming.js'
import { REQUIREMENT_AGENT_PROMPT } from './requirements/prompt.js'
import { createRequirementMcpServer } from './requirements/save-tool.js'
import { reconcileInProgress } from './requirements/reconcile.js'
import { judgeCompletion } from './requirements/judge.js'
import { commitAndPush } from './git.js'
import {
  getAutomationStatus,
  hasPendingQuestion,
  startAutomation,
  stopAutomation,
  type AutomationHooks,
  type DevTurnResult,
  type RunDevTurnInput,
} from './requirements/automation.js'
import { STATIC_ASSETS } from './static-embed.js'
import { mimeFor } from './mime.js'

export interface ServerOptions {
  /** Optional seed workspace — added to the registry and made discoverable. */
  projectPath?: string
  port: number
  dev: boolean
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // Seed the registry with the CLI-provided workspace (idempotent).
  if (opts.projectPath) addWorkspace(opts.projectPath, Date.now())

  const send = (ws: { send: (d: string) => void }, msg: ServerToClient): void =>
    ws.send(JSON.stringify(msg))

  // Every live connection's deliver callback. Used to broadcast session statuses
  // (sidebar badges) to all connections, independent of what each is viewing.
  const connections = new Set<Viewer>()
  const broadcastStatuses = (): void => {
    const statuses = listStatuses()
    for (const deliver of connections) deliver({ type: 'session_status', statuses })
  }
  // Any runtime status change (run start/finish, permission wait) re-broadcasts.
  setOnStatusChange(broadcastStatuses)

  /**
   * Per-requirement runStatus cache, populated by reconcileInProgress on
   * open_requirement_chat and consumed by enrichRunStatus during requirement
   * broadcasts. This is a DERIVED-field cache (runStatus is not stored in the
   * DB); the key is requirement id, and entries are overwritten on each fresh
   * reconcile. Cleared when a requirement leaves in_progress.
   */
  const runStatusCache = new Map<string, RequirementRunStatus>()

  /**
   * Dead-session de-dup for reconcile (perf). Maps requirement id → the
   * `lastDevSessionId` we last ran the completion judge against while its
   * process was dead. Judging a dead session is an LLM call that yields the
   * same verdict every time, yet open_requirement_chat fires on every entry,
   * refresh, and WS reconnect — so we skip a requirement whose CURRENT dead
   * session is already recorded here. A live process (re-derived cheaply) or a
   * brand-new session id (differs from the record) still gets (re)judged.
   * Cleared when a requirement leaves in_progress.
   */
  const judgedSessions = new Map<string, string>()

  /**
   * Enrich a requirements list with the correct (derived) runStatus for each
   * in_progress item. Priority order:
   * 1. Process still running in the runtime registry → `running`.
   * 2. Cached from the most recent reconcile → `dangling` (or `idle` for
   *    auto-completed items whose status hasn't been re-read yet).
   * 3. Fallback → `idle` (no reconcile data — first entry or status changed).
   */
  function enrichRunStatus(items: Requirement[]): Requirement[] {
    return items.map((r) => {
      if (r.status !== 'in_progress') return r
      if (r.lastDevSessionId && isRunning(r.lastDevSessionId))
        return { ...r, runStatus: 'running' as const }
      const cached = runStatusCache.get(r.id)
      if (cached) return { ...r, runStatus: cached }
      return r
    })
  }

  // ---- Session-layer status heartbeat ----

  // How often the server broadcasts a full session-status snapshot (edge-triggered
  // events may drop; this is the periodic safety net for client reconciliation).
  const STATUS_HEARTBEAT_MS = 15_000
  // How long a `running` session can be silent before its run is presumed hung and
  // forcefully converged to `idle`. Conservative — long-running tools (build, deploy)
  // emit no intermediate events but finish much faster than this threshold.
  const RUN_STALE_MS = 5 * 60_000
  // Backoff before the single socket-disconnect auto-`resume` (AS-R18 / AVAIL-7):
  // 3–5s jittered. Bounded — exactly one such wait per turn (no unbounded retry).
  const socketReconnectBackoffMs = (): number => 3_000 + Math.floor(Math.random() * 2_000)
  // Abortable delay: resolves after `ms`, or immediately if the run is stopped.
  const sleepAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
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
    for (const deliver of connections) deliver({ type: 'requirements', projectPath: proj, items })
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
    for (const deliver of connections)
      deliver({ type: 'discussions', projectPath: proj, items, runStates, researchStates })
  }

  // Push a workspace's schedule list to every connection. Used after create,
  // update, delete. No-op when the store is unavailable.
  const broadcastSchedules = (workspacePath: string): void => {
    if (!isScheduleStoreAvailable()) return
    const proj = resolve(workspacePath)
    const items = listSchedules(proj)
    for (const deliver of connections) deliver({ type: 'schedules', workspacePath: proj, items })
  }

  // Per-run control for a live discussion orchestration. `abort` tears it down
  // (server teardown); `paused` + `resumeWaiters` implement a pause gate the loop
  // awaits at each round boundary (no new speech while paused) — resume and abort
  // both wake the waiters so neither resume nor teardown can hang on a paused loop.
  interface DiscussionRunControl {
    abort: AbortController
    paused: boolean
    resumeWaiters: Array<() => void>
  }

  // Live discussion-engine runs, keyed by discussion id. A present entry is the
  // "already running" re-entry guard for `start_discussion` / `continue_discussion`.
  const discussionRuns = new Map<string, DiscussionRunControl>()

  // Live run-state snapshot for a discussion list: id → `running`/`paused` for every listed
  // discussion that currently has an active run (absent = no live run, falls back to status).
  // Rides the `discussions` message so a refresh/reconnect reconciles background runs accurately —
  // `discussion_run_status` only fires on transitions and is missed by a freshly-(re)connected view.
  const discussionRunSnapshot = (items: Discussion[]): Record<string, 'running' | 'paused'> => {
    const snapshot: Record<string, 'running' | 'paused'> = {}
    for (const d of items) {
      const ctrl = discussionRuns.get(d.id)
      if (ctrl) snapshot[d.id] = ctrl.paused ? 'paused' : 'running'
    }
    return snapshot
  }

  // Live research runs, keyed by discussion id. A present entry means the read-only
  // research agent is still working (its abort controller tears it down on teardown).
  // The map's presence IS the liveness: settle (success/fail/dead process) deletes it.
  const researchRuns = new Map<string, AbortController>()

  // Research-phase companion to `discussionRunSnapshot` — id → `running` for every listed
  // discussion with a live research run. Rides the `discussions` send so a refresh/reconnect
  // mid-research rebuilds the research phase (the transition-only `research_run_status` is missed
  // by a freshly-(re)connected view).
  const researchRunSnapshot = (items: Discussion[]): Record<string, 'running'> => {
    const snapshot: Record<string, 'running'> = {}
    for (const d of items) if (researchRuns.has(d.id)) snapshot[d.id] = 'running'
    return snapshot
  }

  // Stream one freshly-appended discussion message to every connection (the
  // frontend appends it when viewing that discussion).
  const broadcastDiscussionMessage = (discussionId: string, message: DiscussionMessage): void => {
    for (const deliver of connections)
      deliver({ type: 'discussion_message', discussionId, message })
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
    for (const deliver of connections) deliver(evt)
  }

  // Broadcast a discussion's live run-state (decoupled from its persisted status).
  const broadcastDiscussionRunStatus = (
    discussionId: string,
    state: 'running' | 'paused' | 'ended',
  ): void => {
    for (const deliver of connections)
      deliver({ type: 'discussion_run_status', discussionId, state })
  }

  // Stream one research turn to every connection (runtime-only — research messages
  // are never persisted; the frontend appends to the right pane's research stream).
  const broadcastResearchMessage = (discussionId: string, item: ResearchStreamItem): void => {
    const message: ResearchMessage = { ...item, discussionId, createdAt: Date.now() }
    for (const deliver of connections) deliver({ type: 'research_message', discussionId, message })
  }

  // Broadcast a discussion's research-run liveness (running while the agent works,
  // ended on finish/fail/dead process). Runtime-only, mirrors discussion_run_status.
  const broadcastResearchRunStatus = (discussionId: string, state: 'running' | 'ended'): void => {
    for (const deliver of connections) deliver({ type: 'research_run_status', discussionId, state })
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
    discussionRuns.set(discussion.id, ctrl)
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
        discussionRuns.delete(discussion.id)
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
    researchRuns.set(discussion.id, abort)
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
        researchRuns.delete(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        broadcastDiscussions(discussion.projectPath)
        // Research failed → leave it a draft for a manual Start. On success, re-validate
        // on the freshest record (it may have been manually Started or cancelled
        // mid-research) before auto-starting the orchestration.
        if (!ok) return
        const latest = getDiscussion(discussion.id)
        if (canAutoStartDiscussion(latest, discussionRuns.has(discussion.id))) {
          startDiscussionRun(latest as Discussion)
        }
      })
      .catch((err) => {
        // Defensive: research itself swallows its run error (returns ok=false), so this
        // only fires on a wiring fault. Still converge liveness so the phase doesn't hang.
        researchRuns.delete(discussion.id)
        broadcastResearchRunStatus(discussion.id, 'ended')
        broadcastDiscussions(discussion.projectPath)
        console.warn(`[c3] discussion research wiring error: ${errMsg(err)}`)
      })
  }

  // Push an automation-orchestrator status to every connection (the frontend
  // keeps a per-project map and renders the one it's viewing).
  const broadcastAutomation = (status: AutomationStatus): void => {
    for (const deliver of connections) deliver({ type: 'automation_status', status })
  }

  /**
   * Shared run launcher, extracted from `user_prompt`. Owns only registry/emit
   * concerns: abort wiring, the prompt echo, status flips, the SDK run, and
   * pending→real id binding. Everything connection-specific (session_started,
   * `viewing`, `activeSessionId`, session-list refresh) is injected via the
   * callbacks, so background launches (`start_development`) and seeded launches
   * (`refine_requirement`) can reuse it. Requirement runtimes get the read-only
   * gate, the disallowed-tools lock, the comm system prompt, the `save_requirements`
   * MCP tool, and a forced `default` permission mode (so `canUseTool` always fires).
   */
  const launchRun = async (
    rt: SessionRuntime,
    prompt: string,
    cbs: {
      onSessionId?: (prevId: string, realId: string) => void
      onSettled?: (workspacePath: string) => void | Promise<void>
    } = {},
  ): Promise<void> => {
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
                    mcpServers: createRequirementMcpServer(workspacePath, broadcastRequirements),
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
                  broadcastStatuses()
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
        void launchRun(rt, input.prompt, {
          onSessionId: (_prev, sid) => {
            setSessionMode(sid, rt.mode)
            // Surface the bind to the orchestrator immediately (early in_progress flip).
            input.onSessionId?.(sid)
          },
        })
      }
    })

  const automationHooks: AutomationHooks = {
    runDevTurn,
    broadcastRequirements,
    emitStatus: broadcastAutomation,
    sessionExists,
    isRunning,
  }

  app.get(
    '/ws',
    upgradeWebSocket(() => {
      // This connection is a *view* onto sessions, not an owner of runs. It holds
      // which session it currently shows; runs live in the module-level registry
      // and survive switching away, refreshes, and disconnects.
      let viewing: string | null = null
      let sock: { send: (d: string) => void } | null = null
      // Stable per-connection delivery: live stream events for the viewed session
      // and broadcast statuses both flow through this.
      const deliver: Viewer = (msg) => {
        if (sock) send(sock, msg)
      }

      const sendWorkspaces = (ws: { send: (d: string) => void }): void =>
        send(ws, { type: 'workspaces', workspaces: listWorkspaces() })

      const sendSessions = async (
        ws: { send: (d: string) => void },
        workspacePath: string,
      ): Promise<void> => {
        try {
          const sessions = await listWorkspaceSessions(workspacePath)
          send(ws, { type: 'sessions', workspacePath, sessions })
        } catch (err) {
          send(ws, {
            type: 'error',
            error: { code: 'session.listFailed', params: { detail: errMsg(err) } },
          })
        }
      }

      return {
        onOpen(_evt, ws) {
          sock = ws
          connections.add(deliver)
          send(ws, {
            type: 'ready',
            workspaces: listWorkspaces(),
            activeSessionId: getActiveSessionId(),
            statuses: listStatuses(),
          })
        },
        async onMessage(evt, ws) {
          let msg: ClientToServer
          try {
            msg = JSON.parse(String(evt.data)) as ClientToServer
          } catch {
            return
          }

          switch (msg.type) {
            case 'ping':
              send(ws, { type: 'pong' })
              return

            case 'request_session_status':
              send(ws, { type: 'session_status', statuses: listStatuses() })
              return

            case 'get_settings':
              send(ws, { type: 'settings', settings: loadSettings() })
              return

            case 'save_settings':
              send(ws, { type: 'settings', settings: saveSettings(msg.settings) })
              return

            case 'permission_response':
              // Clear the pending-prompt guard first so the run's eventual
              // `turn_end` can settle to idle (the prompt is now decided).
              resolvePending(msg.requestId)
              registerPermissionResolver.resolve(msg.requestId, msg.decision, msg.answers)
              return

            case 'add_workspace': {
              const abs = addWorkspace(msg.path, Date.now())
              if (!abs) {
                send(ws, {
                  type: 'error',
                  error: { code: 'path.notDirectory', params: { path: msg.path } },
                })
                return
              }
              sendWorkspaces(ws)
              await sendSessions(ws, abs)
              return
            }

            case 'remove_workspace': {
              const abs = resolve(msg.path)
              // Tear down any background runs under this workspace.
              removeRuntimesForWorkspace(abs)
              // Pause all schedules under this workspace (SCH-R1).
              if (isScheduleStoreAvailable()) {
                onWorkspaceRemoved(abs)
              }
              removeWorkspace(abs)
              if (viewing && getRuntime(viewing) === undefined) viewing = null
              sendWorkspaces(ws)
              broadcastStatuses()
              return
            }

            case 'list_sessions':
              await sendSessions(ws, resolve(msg.workspacePath))
              return

            case 'list_commands': {
              const cwd = viewing ? getRuntime(viewing)?.workspacePath : null
              if (!cwd) {
                send(ws, { type: 'commands', commands: [] })
                return
              }
              try {
                const commands = await listCommands(cwd)
                send(ws, { type: 'commands', commands })
              } catch (err) {
                send(ws, {
                  type: 'error',
                  error: { code: 'command.listFailed', params: { detail: errMsg(err) } },
                })
              }
              return
            }

            case 'create_session': {
              const abs = resolve(msg.workspacePath)
              if (!hasWorkspace(abs)) {
                send(ws, {
                  type: 'error',
                  error: { code: 'workspace.unknown', params: { path: msg.workspacePath } },
                })
                return
              }
              // Switching views never stops a run — just stop watching the old one.
              if (viewing) removeViewer(viewing, deliver)
              const pendingId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
              const defaultMode = getDefaultMode()
              ensureRuntime(pendingId, abs, defaultMode, [])
              viewing = pendingId
              addViewer(pendingId, deliver)
              touchWorkspace(abs, Date.now())
              send(ws, {
                type: 'session_selected',
                workspacePath: abs,
                sessionId: pendingId,
                title: 'New session',
                mode: defaultMode,
                history: [],
                status: 'idle',
              })
              sendWorkspaces(ws)
              return
            }

            case 'select_session': {
              const abs = resolve(msg.workspacePath)
              if (viewing) removeViewer(viewing, deliver)
              try {
                const existing = getRuntime(msg.sessionId)
                const title = await sessionTitle(abs, msg.sessionId)
                // Cold session ⇒ read disk once and seed a runtime; warm session ⇒
                // reuse its in-memory runtime (baseline + live buffer). After this
                // point there is no `await`, so the replay below is atomic w.r.t.
                // concurrent `emit`s.
                const rt = existing
                  ? existing
                  : ensureRuntime(
                      msg.sessionId,
                      abs,
                      getSessionMode(msg.sessionId),
                      await loadHistory(abs, msg.sessionId),
                    )
                viewing = msg.sessionId
                touchWorkspace(abs, Date.now())
                setActiveSessionId(msg.sessionId)
                send(ws, {
                  type: 'session_selected',
                  workspacePath: abs,
                  sessionId: msg.sessionId,
                  title,
                  mode: rt.mode,
                  history: rt.baseline,
                  status: rt.status,
                })
                // Replay everything emitted since the baseline (current + past
                // turns), then start receiving live events.
                for (const e of rt.buffer) send(ws, e)
                addViewer(msg.sessionId, deliver)
                sendWorkspaces(ws)
              } catch (err) {
                send(ws, {
                  type: 'error',
                  error: { code: 'session.openFailed', params: { detail: errMsg(err) } },
                })
              }
              return
            }

            case 'delete_session': {
              const abs = resolve(msg.workspacePath)
              try {
                removeRuntime(msg.sessionId)
                await removeSession(abs, msg.sessionId)
                if (viewing === msg.sessionId) viewing = null
                if (getActiveSessionId() === msg.sessionId) setActiveSessionId(null)
                await sendSessions(ws, abs)
                broadcastStatuses()
              } catch (err) {
                send(ws, {
                  type: 'error',
                  error: { code: 'session.deleteFailed', params: { detail: errMsg(err) } },
                })
              }
              return
            }

            case 'rename_session': {
              const abs = resolve(msg.workspacePath)
              try {
                await renameWorkspaceSession(abs, msg.sessionId, msg.title)
                await sendSessions(ws, abs)
              } catch (err) {
                send(ws, {
                  type: 'error',
                  error: { code: 'session.renameFailed', params: { detail: errMsg(err) } },
                })
              }
              return
            }

            case 'set_mode': {
              const rt = viewing ? getRuntime(viewing) : undefined
              // Requirement comm sessions are pinned to `default` (the gateway
              // must always fire); ignore mode changes for them.
              if (rt && rt.kind === 'requirement') {
                send(ws, { type: 'mode_changed', mode: 'default' })
                return
              }
              if (rt) {
                rt.mode = msg.mode
                // Persist for real sessions; pending sessions persist on bind.
                if (!rt.sessionId.startsWith(PENDING_SESSION_PREFIX)) {
                  setSessionMode(rt.sessionId, msg.mode)
                }
                if (rt.run?.handle) {
                  try {
                    await rt.run.handle.setPermissionMode(msg.mode)
                  } catch {
                    /* query may have finished between check and call — ignore */
                  }
                }
              }
              send(ws, { type: 'mode_changed', mode: msg.mode })
              return
            }

            case 'stop_run': {
              if (viewing) stopRun(viewing)
              return
            }

            case 'user_prompt': {
              const rt = viewing ? getRuntime(viewing) : undefined
              if (!rt) {
                send(ws, { type: 'error', error: { code: 'session.notSelected' } })
                return
              }
              // Team session: the lead process is alive across turns, so feed the
              // prompt into the *same* run (no resume launch). The user may send
              // even while the lead is mid-turn — the SDK queues it.
              if (rt.team && rt.run?.handle) {
                emit(rt.sessionId, { type: 'user_text', text: msg.text })
                setStatus(rt.sessionId, 'running')
                rt.run.handle.pushInput(msg.text)
                return
              }
              if (rt.run) {
                send(ws, { type: 'error', error: { code: 'session.turnRunning' } })
                return
              }
              const isRequirement = rt.kind === 'requirement'
              await launchRun(rt, msg.text, {
                onSessionId: (prev, sid) => {
                  if (isRequirement) {
                    // Comm session: re-key its store mapping; never touch the
                    // persisted active/normal-mode state (it's a hidden session).
                    rebindChatSession(prev, sid)
                    if (viewing === prev) viewing = sid
                  } else {
                    setSessionMode(sid, rt.mode)
                    if (viewing === prev) {
                      viewing = sid
                      setActiveSessionId(sid)
                    }
                  }
                  send(ws, { type: 'session_started', clientId: prev, sessionId: sid })
                },
                // Requirement comm sessions are hidden from the normal list, so
                // there's nothing to refresh for them.
                onSettled: isRequirement
                  ? undefined
                  : async (wp) => {
                      await sendSessions(ws, wp)
                    },
              })
              return
            }

            case 'list_requirements': {
              const proj = resolve(msg.projectPath)
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              send(ws, {
                type: 'requirements',
                projectPath: proj,
                items: listRequirements(proj, msg.status),
              })
              return
            }

            case 'open_requirement_chat': {
              const proj = resolve(msg.projectPath)
              if (!hasWorkspace(proj)) {
                send(ws, {
                  type: 'error',
                  error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
                })
                return
              }
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              // Stop viewing whatever this connection had open.
              if (viewing) removeViewer(viewing, deliver)
              // Resume the project's persisted comm session, or open a new one.
              // This is the single path hit on first entry, WS reconnect, and a
              // hard refresh — all "auto-reload the last comm session".
              const existing = getChatSession(proj)
              let chatId: string
              if (existing) {
                chatId = existing
                if (!getRuntime(chatId)) {
                  const isPending = chatId.startsWith(PENDING_SESSION_PREFIX)
                  const baseline = isPending ? [] : await loadHistory(proj, chatId).catch(() => [])
                  ensureRuntime(chatId, proj, 'default', baseline, 'requirement')
                }
              } else {
                chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
                ensureRuntime(chatId, proj, 'default', [], 'requirement')
                setChatSession(proj, chatId)
              }
              const rt = getRuntime(chatId)
              if (!rt) {
                send(ws, { type: 'error', error: { code: 'requirement.chatOpenFailed' } })
                return
              }
              viewing = chatId
              touchWorkspace(proj, Date.now())
              send(ws, {
                type: 'session_selected',
                workspacePath: proj,
                sessionId: chatId,
                title: 'New Requirement',
                mode: 'default',
                history: rt.baseline,
                status: rt.status,
              })
              for (const e of rt.buffer) send(ws, e)
              addViewer(chatId, deliver)

              // (A) Send the requirement list IMMEDIATELY so the panel renders
              // without waiting on reconciliation. runStatus comes from the live
              // registry / cache (enrichRunStatus); the expensive part — judging
              // dead dev sessions — runs in the background below and re-broadcasts
              // the refreshed list once it settles.
              send(ws, {
                type: 'requirements',
                projectPath: proj,
                items: enrichRunStatus(listRequirements(proj)),
              })
              send(ws, { type: 'automation_status', status: getAutomationStatus(proj) })

              // Reconcile in_progress requirements in the background: for each,
              // check liveness and auto-complete if the process is dead but the
              // judge confirms done. Never blocks the list send above.
              const inProgReqs = listRequirements(proj).filter((r) => r.status === 'in_progress')
              // (B) Skip a requirement whose CURRENT dead session was already judged
              // (same verdict, saved LLM call). Live processes and brand-new session
              // ids fall through and still get (re)judged.
              const toReconcile = inProgReqs.filter((r) => {
                const dead = !(r.lastDevSessionId && isRunning(r.lastDevSessionId))
                if (!dead) return true
                return !r.lastDevSessionId || judgedSessions.get(r.id) !== r.lastDevSessionId
              })
              if (toReconcile.length > 0) {
                const signal = new AbortController()
                const sessionById = new Map(inProgReqs.map((r) => [r.id, r.lastDevSessionId]))
                void reconcileInProgress(
                  toReconcile,
                  proj,
                  {
                    isRunning,
                    loadTranscriptMessages: (p, sid, count) =>
                      loadLastAssistantMessages(p, sid, count),
                    judgeCompletion,
                    commitAndPush,
                    updateStatus,
                  },
                  signal.signal,
                )
                  .then((reconciled) => {
                    if (reconciled.length === 0) return
                    for (const r of reconciled) {
                      // Cache the derived runStatus for enrichRunStatus. Auto-completed
                      // items left in_progress, so their entry won't be read again.
                      runStatusCache.set(r.requirementId, r.runStatus)
                      // Record the dead session we judged so (B) can skip it next
                      // time; a still-running process keeps being re-derived instead.
                      const sid = sessionById.get(r.requirementId)
                      if (sid && r.runStatus !== 'running') judgedSessions.set(r.requirementId, sid)
                    }
                    // Push the refreshed list (updated runStatus + any auto-completes).
                    broadcastRequirements(proj)
                  })
                  .catch((err) => {
                    console.warn(
                      `[c3:reconcile] 对账异常: ${err instanceof Error ? err.message : String(err)}`,
                    )
                  })
              }
              return
            }

            case 'new_requirement_chat': {
              const proj = resolve(msg.projectPath)
              if (!hasWorkspace(proj)) {
                send(ws, {
                  type: 'error',
                  error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
                })
                return
              }
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              // Open a brand-new comm session: setChatSession resets the prior
              // is_current row to 0 and marks this one current, so a refresh /
              // reconnect via open_requirement_chat resumes THIS session.
              if (viewing) removeViewer(viewing, deliver)
              const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
              const rt = ensureRuntime(chatId, proj, 'default', [], 'requirement')
              setChatSession(proj, chatId)
              viewing = chatId
              touchWorkspace(proj, Date.now())
              addViewer(chatId, deliver)
              send(ws, {
                type: 'session_selected',
                workspacePath: proj,
                sessionId: chatId,
                title: 'New Requirement',
                mode: 'default',
                history: [],
                status: rt.status,
              })
              send(ws, {
                type: 'requirements',
                projectPath: proj,
                items: enrichRunStatus(listRequirements(proj)),
              })
              send(ws, { type: 'automation_status', status: getAutomationStatus(proj) })
              return
            }

            case 'refine_requirement': {
              const proj = resolve(msg.projectPath)
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              const req = getRequirement(msg.requirementId)
              if (!req) {
                send(ws, { type: 'error', error: { code: 'requirement.notFound' } })
                return
              }
              // Restart the comm session as a fresh one seeded with this requirement.
              if (viewing) removeViewer(viewing, deliver)
              const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
              const rt = ensureRuntime(chatId, proj, 'default', [], 'requirement')
              setChatSession(proj, chatId)
              viewing = chatId
              addViewer(chatId, deliver)
              send(ws, {
                type: 'session_selected',
                workspacePath: proj,
                sessionId: chatId,
                title: 'New Requirement',
                mode: 'default',
                history: [],
                status: 'idle',
              })
              send(ws, { type: 'requirements', projectPath: proj, items: listRequirements(proj) })
              const firstPrompt = `开始完善需求 ${req.id}。标题:${req.title}。当前内容:${req.content}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_requirements。`
              await launchRun(rt, firstPrompt, {
                onSessionId: (prev, sid) => {
                  rebindChatSession(prev, sid)
                  if (viewing === prev) viewing = sid
                  send(ws, { type: 'session_started', clientId: prev, sessionId: sid })
                },
              })
              return
            }

            case 'discussion_to_requirement': {
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              const discussion = getDiscussion(msg.discussionId)
              if (!discussion) {
                send(ws, { type: 'error', error: { code: 'discussion.notFound' } })
                return
              }
              if (discussion.status !== 'completed' || !discussion.conclusion) {
                send(ws, { type: 'error', error: { code: 'discussion.notConcludable' } })
                return
              }
              const proj = resolve(discussion.projectPath)
              // Seed a fresh comm session with the conclusion — a refine variant.
              if (viewing) removeViewer(viewing, deliver)
              const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
              const rt = ensureRuntime(chatId, proj, 'default', [], 'requirement')
              setChatSession(proj, chatId)
              viewing = chatId
              addViewer(chatId, deliver)
              send(ws, {
                type: 'session_selected',
                workspacePath: proj,
                sessionId: chatId,
                title: 'New Requirement',
                mode: 'default',
                history: [],
                status: 'idle',
              })
              send(ws, { type: 'requirements', projectPath: proj, items: listRequirements(proj) })
              const firstPrompt = `基于以下讨论结论拆分出可验证的需求条目。讨论:${discussion.title}。结论:${discussion.conclusion}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_requirements。`
              await launchRun(rt, firstPrompt, {
                onSessionId: (prev, sid) => {
                  rebindChatSession(prev, sid)
                  if (viewing === prev) viewing = sid
                  send(ws, { type: 'session_started', clientId: prev, sessionId: sid })
                },
              })
              return
            }

            case 'start_development': {
              const proj = resolve(msg.projectPath)
              if (!hasWorkspace(proj)) {
                send(ws, {
                  type: 'error',
                  error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
                })
                return
              }
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              const req = getRequirement(msg.requirementId)
              if (!req) {
                send(ws, { type: 'error', error: { code: 'requirement.notFound' } })
                return
              }
              // Allow `todo`, or `in_progress` whose dev session has gone missing
              // (a dangling launch — let the user restart rather than stay stuck).
              const dangling =
                req.status === 'in_progress' &&
                (!req.lastDevSessionId || !(await sessionExists(proj, req.lastDevSessionId)))
              if (req.status !== 'todo' && !dangling) {
                send(ws, {
                  type: 'error',
                  error: { code: 'requirement.cannotStartDev', params: { status: req.status } },
                })
                return
              }
              const devId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
              const devRt = ensureRuntime(devId, proj, getDefaultMode(), [], 'normal')
              const depNote = req.dependsOn.length ? `\n\n依赖需求:${req.dependsOn.join(', ')}` : ''
              const skill = getDevSkill()
              const skillPrefix = skill ? `${skill} ` : ''
              const devPrompt = `${skillPrefix}${req.title}\n\n${req.content}${depNote}`
              // Background launch: don't await — it runs detached, surviving this
              // connection. Status flips to in_progress once the SDK id binds.
              void launchRun(devRt, devPrompt, {
                onSessionId: (prev, sid) => {
                  setSessionMode(sid, devRt.mode)
                  setLastDevSession(req.id, sid)
                  updateStatus(req.id, 'in_progress')
                  broadcastRequirements(proj)
                  send(ws, { type: 'session_started', clientId: prev, sessionId: sid })
                },
                onSettled: async (wp) => {
                  await sendSessions(ws, wp)
                },
              })
              return
            }

            case 'update_requirement_status': {
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              const req = getRequirement(msg.requirementId)
              if (!req) {
                send(ws, { type: 'error', error: { code: 'requirement.notFound' } })
                return
              }
              updateStatus(msg.requirementId, msg.status)
              // If the requirement leaves in_progress, clear its cache entry so
              // a future restart doesn't show a stale dangling/ running label.
              if (req.status === 'in_progress' && msg.status !== 'in_progress') {
                runStatusCache.delete(msg.requirementId)
                judgedSessions.delete(msg.requirementId)
              }
              broadcastRequirements(req.projectPath)
              return
            }

            case 'set_requirement_automate': {
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              const req = getRequirement(msg.requirementId)
              if (!req) {
                send(ws, { type: 'error', error: { code: 'requirement.notFound' } })
                return
              }
              setAutomate(msg.requirementId, msg.automate)
              broadcastRequirements(req.projectPath)
              return
            }

            case 'start_automation': {
              const proj = resolve(msg.projectPath)
              if (!hasWorkspace(proj)) {
                send(ws, {
                  type: 'error',
                  error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
                })
                return
              }
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'requirement.dbUnavailable' } })
                return
              }
              broadcastAutomation(startAutomation(proj, automationHooks, Date.now()))
              return
            }

            case 'stop_automation': {
              const proj = resolve(msg.projectPath)
              broadcastAutomation(stopAutomation(proj))
              return
            }

            case 'list_discussions': {
              const proj = resolve(msg.projectPath)
              if (!isDiscussionStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'discussion.dbUnavailable' } })
                return
              }
              const discItems = listDiscussions(proj, msg.status)
              send(ws, {
                type: 'discussions',
                projectPath: proj,
                items: discItems,
                runStates: discussionRunSnapshot(discItems),
              })
              return
            }

            case 'create_discussion': {
              if (!isDiscussionStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'discussion.dbUnavailable' } })
                return
              }
              if (!isDiscussionType(msg.discussionType)) {
                send(ws, {
                  type: 'error',
                  error: { code: 'discussion.unknownType', params: { type: msg.discussionType } },
                })
                return
              }
              const proj = resolve(msg.projectPath)
              // Title is derived from the goal (the form has no title field): first
              // non-empty line, trimmed and capped.
              const firstLine =
                msg.goal
                  .split('\n')
                  .map((l) => l.trim())
                  .find(Boolean) ?? ''
              const title = (firstLine || 'Discussion').slice(0, 80)
              const created = createDiscussion({
                projectPath: proj,
                title,
                type: msg.discussionType,
                goal: msg.goal,
                context: msg.context ?? '',
                status: 'draft',
              })
              // Open the new discussion on the creating connection right away (so
              // the right pane shows it without a manual click) and push the draft
              // to every connection's list. Then run the read-only research agent
              // in the background to complete its context; when it succeeds we
              // auto-start the orchestration (equivalent to an auto `start_discussion`).
              // Fire-and-forget: research never blocks creation.
              send(ws, { type: 'discussion_detail', discussion: created, messages: [] })
              broadcastDiscussions(proj)
              // Run the read-only research agent as an observable run: it streams its
              // turns to the right pane and broadcasts its liveness, then auto-starts the
              // orchestration on success (see startResearchRun).
              startResearchRun(created)
              return
            }

            case 'open_discussion': {
              if (!isDiscussionStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'discussion.dbUnavailable' } })
                return
              }
              const discussion = getDiscussion(msg.discussionId)
              if (!discussion) {
                send(ws, {
                  type: 'error',
                  error: { code: 'discussion.unknown', params: { id: msg.discussionId } },
                })
                return
              }
              send(ws, {
                type: 'discussion_detail',
                discussion,
                messages: listDiscussionMessages(msg.discussionId),
              })
              return
            }

            case 'start_discussion': {
              if (!isDiscussionStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'discussion.dbUnavailable' } })
                return
              }
              const discussion = getDiscussion(msg.discussionId)
              if (!discussion) {
                send(ws, {
                  type: 'error',
                  error: { code: 'discussion.unknown', params: { id: msg.discussionId } },
                })
                return
              }
              // Idempotent guards: only a `draft` can be started, and never twice.
              if (discussionRuns.has(discussion.id)) return
              if (discussion.status !== 'draft') {
                send(ws, { type: 'error', error: { code: 'discussion.alreadyStarted' } })
                return
              }
              startDiscussionRun(discussion)
              return
            }

            case 'pause_discussion': {
              const ctrl = discussionRuns.get(msg.discussionId)
              if (!ctrl || ctrl.paused) return
              ctrl.paused = true
              broadcastDiscussionRunStatus(msg.discussionId, 'paused')
              return
            }

            case 'resume_discussion': {
              const ctrl = discussionRuns.get(msg.discussionId)
              if (!ctrl || !ctrl.paused) return
              ctrl.paused = false
              const waiters = ctrl.resumeWaiters.splice(0)
              for (const wake of waiters) wake()
              broadcastDiscussionRunStatus(msg.discussionId, 'running')
              return
            }

            case 'discussion_speak': {
              if (!isDiscussionStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'discussion.dbUnavailable' } })
                return
              }
              const discussion = getDiscussion(msg.discussionId)
              if (!discussion) {
                send(ws, {
                  type: 'error',
                  error: { code: 'discussion.unknown', params: { id: msg.discussionId } },
                })
                return
              }
              const text = msg.text.trim()
              if (!text) return
              // Pause the live run (if any) so the human message lands at a round
              // boundary, append + stream it, then resume — the organizer's next
              // round picks it up from the transcript.
              const ctrl = discussionRuns.get(msg.discussionId)
              if (ctrl) {
                ctrl.paused = true
                broadcastDiscussionRunStatus(msg.discussionId, 'paused')
              }
              const message = appendDiscussionMessage({
                discussionId: msg.discussionId,
                speakerKind: 'human',
                speakerName: 'Human',
                content: text,
              })
              broadcastDiscussionMessage(msg.discussionId, message)
              if (ctrl) {
                ctrl.paused = false
                const waiters = ctrl.resumeWaiters.splice(0)
                for (const wake of waiters) wake()
                broadcastDiscussionRunStatus(msg.discussionId, 'running')
              }
              return
            }

            case 'continue_discussion': {
              if (!isDiscussionStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'discussion.dbUnavailable' } })
                return
              }
              const discussion = getDiscussion(msg.discussionId)
              if (!discussion) {
                send(ws, {
                  type: 'error',
                  error: { code: 'discussion.unknown', params: { id: msg.discussionId } },
                })
                return
              }
              // Re-entry guard + only a concluded discussion can start a new round.
              if (discussionRuns.has(discussion.id)) return
              if (discussion.status !== 'completed') {
                send(ws, { type: 'error', error: { code: 'discussion.notEndedForContinue' } })
                return
              }
              const text = msg.text.trim()
              if (!text) return
              // Append the human's follow-up, flip back to in_progress, and re-run
              // the engine over the full transcript (prior conclusion + new question).
              const message = appendDiscussionMessage({
                discussionId: discussion.id,
                speakerKind: 'human',
                speakerName: 'Human',
                content: text,
              })
              broadcastDiscussionMessage(discussion.id, message)
              updateDiscussionStatus(discussion.id, 'in_progress')
              broadcastDiscussions(discussion.projectPath)
              startDiscussionRun({ ...discussion, status: 'in_progress' })
              return
            }

            case 'create_schedule': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              // Name is auto-generated server-side from the task content; any
              // client-supplied name in config is ignored (stripped by the store).
              const generatedName = await generateScheduleName(msg.input)
              const created = createSchedule(msg.input, generatedName)
              broadcastSchedules(created.workspacePath)
              return
            }

            case 'list_schedules': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              const proj = resolve(msg.workspacePath)
              const items = listSchedules(proj)
              send(ws, { type: 'schedules', workspacePath: proj, items })
              return
            }

            case 'update_schedule': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              const existing = getSchedule(msg.scheduleId)
              if (!existing) {
                send(ws, { type: 'error', error: { code: 'schedule.notFound' } })
                return
              }
              updateScheduleStore(msg.scheduleId, msg.input)
              broadcastSchedules(existing.workspacePath)
              return
            }

            case 'delete_schedule': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              const existing = getSchedule(msg.scheduleId)
              if (!existing) {
                send(ws, { type: 'error', error: { code: 'schedule.notFound' } })
                return
              }
              deleteScheduleStore(msg.scheduleId)
              broadcastSchedules(existing.workspacePath)
              return
            }

            case 'get_schedule_detail': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              const detail = getScheduleDetail(msg.scheduleId)
              if (!detail.schedule) {
                send(ws, { type: 'error', error: { code: 'schedule.notFound' } })
                return
              }
              send(ws, {
                type: 'schedule_detail',
                schedule: detail.schedule,
                logs: detail.logs,
              })
              return
            }

            case 'get_execution_transcript': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              const transcript = await readExecutionTranscript(msg.executionId)
              if (!transcript) {
                send(ws, { type: 'error', error: { code: 'schedule.executionNotFound' } })
                return
              }
              send(ws, {
                type: 'execution_transcript',
                executionId: msg.executionId,
                sessionId: transcript.sessionId,
                items: transcript.items,
              })
              return
            }

            case 'schedule_run_now': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              void triggerRunNow(msg.scheduleId).then(() => {
                const s = getSchedule(msg.scheduleId)
                if (s) broadcastSchedules(s.workspacePath)
              })
              return
            }

            case 'get_workspace_mcp_config': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              const config = storeGetWorkspaceMcpConfig(msg.workspacePath)
              send(ws, { type: 'workspace_mcp_config', workspacePath: msg.workspacePath, config })
              return
            }

            case 'save_workspace_mcp_config': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              storeSaveWorkspaceMcpConfig(msg.workspacePath, msg.config)
              send(ws, {
                type: 'workspace_mcp_config',
                workspacePath: msg.workspacePath,
                config: storeGetWorkspaceMcpConfig(msg.workspacePath),
              })
              return
            }

            case 'list_pending_write_approvals': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              const items = storeListPendingApprovals(msg.workspacePath)
              send(ws, { type: 'pending_write_approvals', workspacePath: msg.workspacePath, items })
              return
            }

            case 'approve_write_approval': {
              if (!isScheduleStoreAvailable()) {
                send(ws, { type: 'error', error: { code: 'schedule.dbUnavailable' } })
                return
              }
              const ok = resolveApproval(msg.approvalId, msg.decision, 'owner')
              if (!ok) {
                send(ws, { type: 'error', error: { code: 'schedule.approvalNotFound' } })
              }
              // Broadcast resolved event is already handled inside resolveApproval
              return
            }
          }
        },
        onClose() {
          // Keep runs alive in the background; just stop delivering to this view.
          if (viewing) removeViewer(viewing, deliver)
          connections.delete(deliver)
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
        for (const deliver of connections) {
          deliver({ type: 'schedule_write_approval_pending', approval })
        }
      } else if (event.type === 'resolved') {
        const r = event.approval as {
          approvalId: string
          status: 'approved' | 'rejected' | 'expired'
          scheduleId?: string
        }
        for (const deliver of connections) {
          deliver({
            type: 'schedule_write_approval_resolved',
            approvalId: r.approvalId,
            status: r.status,
            scheduleId: r.scheduleId ?? '',
          })
        }
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
