import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientToServer, PermissionMode, ServerToClient } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { runClaude, registerPermissionResolver, type RunHandle } from './claude.js'
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

  app.get(
    '/ws',
    upgradeWebSocket(() => {
      let runAbort: AbortController | null = null
      let runHandle: RunHandle | null = null
      // The session the next prompt runs against. A pending id (`pending:…`)
      // means a not-yet-created session; it binds to a real id on first run.
      let activeWorkspace: string | null = null
      let activeSession: string | null = null
      // The active session's mode — source of truth for the next run; mirrored
      // into persisted state for real (non-pending) sessions.
      let activeMode: PermissionMode = 'default'

      const send = (ws: { send: (d: string) => void }, msg: ServerToClient): void =>
        ws.send(JSON.stringify(msg))

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
          send(ws, {
            type: 'ready',
            workspaces: listWorkspaces(),
            activeSessionId: getActiveSessionId(),
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
              registerPermissionResolver.resolve(msg.requestId, msg.decision)
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
              removeWorkspace(abs)
              if (activeWorkspace === abs) {
                activeWorkspace = null
                activeSession = null
              }
              sendWorkspaces(ws)
              return
            }

            case 'list_sessions':
              await sendSessions(ws, resolve(msg.workspacePath))
              return

            case 'list_commands': {
              if (!activeWorkspace) {
                send(ws, { type: 'commands', commands: [] })
                return
              }
              try {
                const commands = await listCommands(activeWorkspace)
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
              runAbort?.abort()
              activeWorkspace = abs
              activeSession = `${PENDING_SESSION_PREFIX}${randomUUID()}`
              activeMode = 'default'
              touchWorkspace(abs, Date.now())
              send(ws, {
                type: 'session_selected',
                workspacePath: abs,
                sessionId: activeSession,
                title: 'New session',
                mode: activeMode,
                history: [],
              })
              sendWorkspaces(ws)
              return
            }

            case 'select_session': {
              const abs = resolve(msg.workspacePath)
              runAbort?.abort()
              try {
                const history = await loadHistory(abs, msg.sessionId)
                const title = await sessionTitle(abs, msg.sessionId)
                activeWorkspace = abs
                activeSession = msg.sessionId
                activeMode = getSessionMode(msg.sessionId)
                touchWorkspace(abs, Date.now())
                setActiveSessionId(msg.sessionId)
                send(ws, {
                  type: 'session_selected',
                  workspacePath: abs,
                  sessionId: msg.sessionId,
                  title,
                  mode: activeMode,
                  history,
                })
                sendWorkspaces(ws)
              } catch (err) {
                send(ws, { type: 'error', message: `Failed to open session: ${errMsg(err)}` })
              }
              return
            }

            case 'delete_session': {
              const abs = resolve(msg.workspacePath)
              try {
                await removeSession(abs, msg.sessionId)
                if (activeSession === msg.sessionId) {
                  activeSession = null
                  if (getActiveSessionId() === msg.sessionId) setActiveSessionId(null)
                }
                await sendSessions(ws, abs)
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
              activeMode = msg.mode
              // Persist for real sessions; pending sessions persist on bind.
              if (activeSession && !activeSession.startsWith(PENDING_SESSION_PREFIX)) {
                setSessionMode(activeSession, msg.mode)
              }
              if (runHandle) {
                try {
                  await runHandle.setPermissionMode(msg.mode)
                } catch {
                  /* query may have finished between check and call — ignore */
                }
              }
              send(ws, { type: 'mode_changed', mode: activeMode })
              return
            }

            case 'user_prompt': {
              if (!activeWorkspace || !activeSession) {
                send(ws, { type: 'error', message: 'Select or create a session first.' })
                return
              }
              const workspacePath = activeWorkspace
              const clientId = activeSession
              const resume = clientId.startsWith(PENDING_SESSION_PREFIX) ? undefined : clientId
              // Launch with the session's agent overrides, or the default agent's
              // when unassigned (pending sessions are always unassigned ⇒ default).
              const launch = resolveSessionLaunch(clientId)

              runAbort?.abort()
              const abort = new AbortController()
              runAbort = abort
              try {
                await runClaude({
                  prompt: msg.text,
                  cwd: workspacePath,
                  signal: abort.signal,
                  permissionMode: activeMode,
                  resume,
                  envOverrides: launch.envOverrides,
                  model: launch.model,
                  currentAgentId: launch.agentId,
                  send: (m) => send(ws, m),
                  onStart: (h) => (runHandle = h),
                  onSessionId: (sid) => {
                    // Bind a pending (or freshly forked) session to its real id.
                    if (activeSession === clientId && clientId !== sid) {
                      activeSession = sid
                      setSessionMode(sid, activeMode)
                      setActiveSessionId(sid)
                      send(ws, { type: 'session_started', clientId, sessionId: sid })
                    }
                  },
                })
              } catch (err) {
                send(ws, { type: 'turn_end', reason: 'error', error: errMsg(err) })
              } finally {
                if (runAbort === abort) {
                  runAbort = null
                  runHandle = null
                }
                // Refresh the list so the new/updated session shows its title.
                await sendSessions(ws, workspacePath)
              }
              return
            }
          }
        },
        onClose() {
          runAbort?.abort()
          runAbort = null
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
