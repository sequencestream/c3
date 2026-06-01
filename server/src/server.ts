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
  Requirement,
  RequirementRunStatus,
  ServerToClient,
} from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { runClaude, registerPermissionResolver, REQUIREMENT_DISALLOWED_TOOLS } from './claude.js'
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
    const resume = runId.startsWith(PENDING_SESSION_PREFIX) ? undefined : runId
    const launch = resolveSessionLaunch(runId)
    const isRequirement = rt.kind === 'requirement'

    const abort = new AbortController()
    rt.run = { abort, handle: null }
    // Echo the prompt into the stream so switch-back replay shows it (for a
    // seeded run this surfaces the injected first message, by design).
    emit(runId, { type: 'user_text', text: prompt })
    setStatus(runId, 'running')
    try {
      await runClaude({
        prompt,
        cwd: workspacePath,
        signal: abort.signal,
        // Requirement chats are pinned to `default` so the gateway always runs.
        permissionMode: isRequirement ? 'default' : rt.mode,
        resume,
        envOverrides: launch.envOverrides,
        model: launch.model,
        currentAgentId: launch.agentId,
        ...(isRequirement
          ? {
              appendSystemPrompt: REQUIREMENT_AGENT_PROMPT,
              disallowedTools: REQUIREMENT_DISALLOWED_TOOLS,
              mcpServers: createRequirementMcpServer(workspacePath, broadcastRequirements),
              gate: 'requirement' as const,
            }
          : {}),
        send: (m) => emit(runId, m),
        onStart: (h) => {
          if (rt.run) rt.run.handle = h
        },
        onSessionId: (sid) => {
          if (runId !== sid) {
            const prev = runId
            bindPending(prev, sid)
            runId = sid
            cbs.onSessionId?.(prev, sid)
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
      })
    } catch (err) {
      emit(runId, { type: 'turn_end', reason: 'error', error: errMsg(err) })
    } finally {
      if (rt.run?.abort === abort) rt.run = null
      // The run is fully over (team sessions only reach here on user stop), so the
      // team is no longer live — clear the flag and fall back to idle.
      rt.team = false
      // Drop any still-pending permission prompt: the run is gone, so it can no
      // longer be answered. Clearing keeps a stale id from holding a *future* turn
      // (same runtime, resumed session) at awaiting_permission.
      clearPending(runId)
      // Authoritative terminal-state backstop. The run is fully over; guarantee a
      // terminal `turn_end` is broadcast and the session settles to `idle` — no
      // longer only when `wasAborted`. This also covers a run loop that ended
      // without a clean `result` (the SDK iterator finished or the Claude process
      // exited mid-turn): `finalizeRun` synthesizes the missing `turn_end` so the
      // viewer's input unlocks and its pending-send queue can flush. Idempotent:
      // a run that already emitted `turn_end` only gets the `idle` settle.
      finalizeRun(runId)
      await cbs.onSettled?.(workspacePath)
    }
  }

  /**
   * Run one dev turn for the automation orchestrator and resolve once it settles.
   * Observes the runtime via an internal viewer: the last assistant text is the
   * "completion message" the judge reads; a `turn_end` resolves complete/error; a
   * `permission_request` means a human is needed, so it aborts the run and resolves
   * `blocked`. A fresh `sessionId` (null) launches a new dev session; a real
   * id resumes it (the "继续" continuation) — or feeds a live team lead directly.
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
          // A human authorization is needed — automation can't answer it. Abort the
          // (otherwise-hanging) run and report it as blocked.
          stopRun(rt.sessionId)
          finish({
            outcome: 'blocked',
            sessionId: rt.sessionId,
            lastMessage: lastText,
            detail: e.toolName,
          })
        } else if (e.type === 'turn_end') {
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
          // stop, not "继续" over it — flag it so develop()'s guard catches a
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
          send(ws, { type: 'error', message: `Failed to list sessions: ${errMsg(err)}` })
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
                send(ws, { type: 'error', message: `Not a directory: ${msg.path}` })
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
                send(ws, { type: 'error', message: `Failed to list commands: ${errMsg(err)}` })
              }
              return
            }

            case 'create_session': {
              const abs = resolve(msg.workspacePath)
              if (!hasWorkspace(abs)) {
                send(ws, { type: 'error', message: `Unknown workspace: ${msg.workspacePath}` })
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
                send(ws, { type: 'error', message: `Failed to open session: ${errMsg(err)}` })
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
                send(ws, { type: 'error', message: `Failed to delete session: ${errMsg(err)}` })
              }
              return
            }

            case 'rename_session': {
              const abs = resolve(msg.workspacePath)
              try {
                await renameWorkspaceSession(abs, msg.sessionId, msg.title)
                await sendSessions(ws, abs)
              } catch (err) {
                send(ws, { type: 'error', message: `Failed to rename session: ${errMsg(err)}` })
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
                send(ws, { type: 'error', message: 'Select or create a session first.' })
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
                send(ws, { type: 'error', message: 'A turn is already running in this session.' })
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
                send(ws, { type: 'error', message: '需求功能不可用 (c3.db)。' })
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
                send(ws, { type: 'error', message: `Unknown workspace: ${msg.projectPath}` })
                return
              }
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', message: '需求功能不可用 (c3.db)。' })
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
                send(ws, { type: 'error', message: 'Failed to open requirement chat.' })
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
                send(ws, { type: 'error', message: `Unknown workspace: ${msg.projectPath}` })
                return
              }
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', message: '需求功能不可用 (c3.db)。' })
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
                send(ws, { type: 'error', message: '需求功能不可用 (c3.db)。' })
                return
              }
              const req = getRequirement(msg.requirementId)
              if (!req) {
                send(ws, { type: 'error', message: '需求不存在。' })
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

            case 'start_development': {
              const proj = resolve(msg.projectPath)
              if (!hasWorkspace(proj)) {
                send(ws, { type: 'error', message: `Unknown workspace: ${msg.projectPath}` })
                return
              }
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', message: '需求功能不可用 (c3.db)。' })
                return
              }
              const req = getRequirement(msg.requirementId)
              if (!req) {
                send(ws, { type: 'error', message: '需求不存在。' })
                return
              }
              // Allow `todo`, or `in_progress` whose dev session has gone missing
              // (a dangling launch — let the user restart rather than stay stuck).
              const dangling =
                req.status === 'in_progress' &&
                (!req.lastDevSessionId || !(await sessionExists(proj, req.lastDevSessionId)))
              if (req.status !== 'todo' && !dangling) {
                send(ws, { type: 'error', message: `当前状态(${req.status})不可启动开发。` })
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
                send(ws, { type: 'error', message: '需求功能不可用 (c3.db)。' })
                return
              }
              const req = getRequirement(msg.requirementId)
              if (!req) {
                send(ws, { type: 'error', message: '需求不存在。' })
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
                send(ws, { type: 'error', message: '需求功能不可用 (c3.db)。' })
                return
              }
              const req = getRequirement(msg.requirementId)
              if (!req) {
                send(ws, { type: 'error', message: '需求不存在。' })
                return
              }
              setAutomate(msg.requirementId, msg.automate)
              broadcastRequirements(req.projectPath)
              return
            }

            case 'start_automation': {
              const proj = resolve(msg.projectPath)
              if (!hasWorkspace(proj)) {
                send(ws, { type: 'error', message: `Unknown workspace: ${msg.projectPath}` })
                return
              }
              if (!isStoreAvailable()) {
                send(ws, { type: 'error', message: '需求功能不可用 (c3.db)。' })
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
