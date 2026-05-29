import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientToServer, ServerToClient } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { runClaude, registerPermissionResolver } from './claude.js'
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
  removeSession,
  renameWorkspaceSession,
  sessionTitle,
} from './sessions.js'
import { loadSettings, saveSettings, resolveSessionLaunch } from './settings.js'
import {
  addViewer,
  bindPending,
  ensureRuntime,
  getRuntime,
  listStatuses,
  removeRuntime,
  removeRuntimesForWorkspace,
  removeViewer,
  setOnStatusChange,
  setStatus,
  stopRun,
  emit,
  type Viewer,
} from './runs.js'
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

            case 'get_settings':
              send(ws, { type: 'settings', settings: loadSettings() })
              return

            case 'save_settings':
              send(ws, { type: 'settings', settings: saveSettings(msg.settings) })
              return

            case 'permission_response':
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
              ensureRuntime(pendingId, abs, 'default', [])
              viewing = pendingId
              addViewer(pendingId, deliver)
              touchWorkspace(abs, Date.now())
              send(ws, {
                type: 'session_selected',
                workspacePath: abs,
                sessionId: pendingId,
                title: 'New session',
                mode: 'default',
                history: [],
                running: false,
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
                  running: rt.run != null,
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
              if (rt.run) {
                send(ws, { type: 'error', message: 'A turn is already running in this session.' })
                return
              }
              const workspacePath = rt.workspacePath
              // `runId` tracks the runtime's current key; it rebinds from a pending
              // id to the real SDK id once the first run reports one.
              let runId = rt.sessionId
              const resume = runId.startsWith(PENDING_SESSION_PREFIX) ? undefined : runId
              // Launch with the session's agent overrides, or the default agent's
              // when unassigned (pending sessions are always unassigned ⇒ default).
              const launch = resolveSessionLaunch(runId)

              const abort = new AbortController()
              rt.run = { abort, handle: null }
              // Echo the prompt into the stream so switch-back replay shows it.
              emit(runId, { type: 'user_text', text: msg.text })
              setStatus(runId, 'running')
              try {
                await runClaude({
                  prompt: msg.text,
                  cwd: workspacePath,
                  signal: abort.signal,
                  permissionMode: rt.mode,
                  resume,
                  envOverrides: launch.envOverrides,
                  model: launch.model,
                  currentAgentId: launch.agentId,
                  send: (m) => emit(runId, m),
                  onStart: (h) => {
                    if (rt.run) rt.run.handle = h
                  },
                  onSessionId: (sid) => {
                    // Bind a pending (or freshly forked) session to its real id.
                    if (runId !== sid) {
                      const prev = runId
                      bindPending(prev, sid)
                      runId = sid
                      setSessionMode(sid, rt.mode)
                      if (viewing === prev) {
                        viewing = sid
                        setActiveSessionId(sid)
                      }
                      send(ws, { type: 'session_started', clientId: prev, sessionId: sid })
                      broadcastStatuses()
                    }
                  },
                })
              } catch (err) {
                emit(runId, { type: 'turn_end', reason: 'error', error: errMsg(err) })
              } finally {
                const wasAborted = abort.signal.aborted
                if (rt.run?.abort === abort) rt.run = null
                // An aborted run never sends turn_end from the run loop; emit one
                // so the viewer's input unlocks. A normal/errored run already did.
                if (wasAborted) emit(runId, { type: 'turn_end', reason: 'complete' })
                setStatus(runId, 'idle')
                // Refresh the list so the new/updated session shows its title.
                await sendSessions(ws, workspacePath)
              }
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
