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
import { REQUIREMENT_DISALLOWED_TOOLS } from './kernel/agent/index.js'
import { launchRun, type LaunchRunDeps } from './kernel/run/run-lifecycle.js'
import { addWorkspace, getActiveSessionId, listWorkspaces, setSessionMode } from './state.js'
import { listWorkspaceSessions, sessionExists } from './sessions.js'
import { getDefaultMode } from './kernel/config/index.js'
import {
  addViewer,
  ensureRuntime,
  listStatuses,
  reconcileLiveness,
  removeViewer,
  setOnStatusChange,
  setStatus,
  stopRun,
  emit,
  isRunning,
  type Viewer,
} from './runs.js'
import { isStoreAvailable, listRequirements } from './features/requirements/store.js'
import { enrichRunStatus } from './features/requirements/run-status.js'
import {
  isStoreAvailable as isDiscussionStoreAvailable,
  listDiscussions,
  getDiscussion,
  setDiscussionResearchResult,
} from './features/discussions/store.js'
import {
  deleteDiscussionRun,
  deleteResearchRun,
  discussionRunSnapshot,
  hasDiscussionRun,
  researchRunSnapshot,
  setDiscussionRun,
  setResearchRun,
  type DiscussionRunControl,
} from './features/discussions/run-controls.js'
import {
  researchDiscussionContext,
  canAutoStartDiscussion,
  type ResearchStreamItem,
} from './features/discussions/research.js'
import {
  runDiscussion,
  defaultDiscussionDeps,
  type DispatchStatus,
} from './features/discussions/orchestrator.js'
import {
  isStoreAvailable as isScheduleStoreAvailable,
  listSchedules,
  getSchedule,
  updateSchedule as updateScheduleStore,
  appendExecutionLog,
  getDueSchedules,
  updateNextRunAt,
  updateExecutionLog,
} from './features/schedules/store.js'
import { startScheduler, stopScheduler, setExecutionStore } from './features/schedules/scheduler.js'
import {
  setBroadcast as setApprovalBroadcast,
  startExpiryScanner,
  stopExpiryScanner,
} from './features/schedules/queue.js'
import { REQUIREMENT_AGENT_PROMPT } from './features/requirements/prompt.js'
import { createRequirementMcpServer } from './features/requirements/save-tool.js'
import {
  hasPendingQuestion,
  setAutomationHooks,
  type DevTurnResult,
  type RunDevTurnInput,
} from './features/requirements/automation.js'
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

  // Wire the automation hooks into the requirements feature (feature-private,
  // ADR-0009 R1: NOT on the kernel context). Mirrors the schedules feature's
  // setExecutionStore/setBroadcast startup injection.
  setAutomationHooks({
    runDevTurn,
    broadcastRequirements,
    emitStatus: broadcastAutomation,
    sessionExists,
    isRunning,
  })

  // ── Composition root (ADR-0009 R3): construct the KernelContext ONCE,
  // explicitly, and inject it into every handler at dispatch time. It holds the
  // cross-feature services (launcher, broadcasts, run starters); feature-private
  // state lives in each feature's store/module (2/3a + automation hooks above),
  // and slice 2/3b folds the broadcasts into a single transport/Broadcaster.
  // `launchDeps` is the bag the top-level `launchRun` reads. The requirement
  // profile (the read-only gate + disallowed-tools lock + comm prompt +
  // save_requirements MCP tool) is wired HERE, at the composition root — the
  // only layer allowed to import features/ — so the kernel launcher stays
  // features-free (ADR-0009 R1).
  const launchDeps: LaunchRunDeps = {
    broadcastStatuses,
    broadcastRequirements,
    requirementProfile: (workspacePath) => ({
      appendSystemPrompt: REQUIREMENT_AGENT_PROMPT,
      disallowedTools: REQUIREMENT_DISALLOWED_TOOLS,
      mcpServers: createRequirementMcpServer(workspacePath, broadcastRequirements),
      gate: 'requirement' as const,
    }),
  }
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
