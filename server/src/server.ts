import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClientToServer, PermissionMode, ServerToClient } from '@ccc/shared/protocol'
import { runClaude, registerPermissionResolver, type RunHandle } from './claude.js'
import { STATIC_ASSETS } from './static-embed.js'
import { mimeFor } from './mime.js'

export interface ServerOptions {
  projectPath: string
  port: number
  dev: boolean
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  app.get(
    '/ws',
    upgradeWebSocket(() => {
      let runAbort: AbortController | null = null
      // Permission mode persists across prompts for the life of the connection.
      let currentMode: PermissionMode = 'default'
      // Live handle to the in-flight run, if any (null between prompts).
      let runHandle: RunHandle | null = null

      return {
        onOpen(_evt, ws) {
          const ready: ServerToClient = { type: 'ready', mode: currentMode }
          ws.send(JSON.stringify(ready))
        },
        async onMessage(evt, ws) {
          let msg: ClientToServer
          try {
            msg = JSON.parse(String(evt.data)) as ClientToServer
          } catch {
            return
          }
          if (msg.type === 'ping') {
            const pong: ServerToClient = { type: 'pong' }
            ws.send(JSON.stringify(pong))
            return
          }
          if (msg.type === 'permission_response') {
            registerPermissionResolver.resolve(msg.requestId, msg.decision)
            return
          }
          if (msg.type === 'set_mode') {
            currentMode = msg.mode
            // Apply to the live run immediately if one is in flight; otherwise
            // it takes effect on the next prompt.
            if (runHandle) {
              try {
                await runHandle.setPermissionMode(msg.mode)
              } catch {
                /* query may have finished between check and call — ignore */
              }
            }
            const changed: ServerToClient = { type: 'mode_changed', mode: currentMode }
            ws.send(JSON.stringify(changed))
            return
          }
          if (msg.type === 'user_prompt') {
            runAbort?.abort()
            const abort = new AbortController()
            runAbort = abort
            try {
              await runClaude({
                prompt: msg.text,
                projectPath: opts.projectPath,
                signal: abort.signal,
                permissionMode: currentMode,
                send: (m) => ws.send(JSON.stringify(m)),
                onStart: (h) => (runHandle = h),
              })
            } catch (err) {
              const end: ServerToClient = {
                type: 'session_end',
                reason: 'error',
                error: err instanceof Error ? err.message : String(err),
              }
              ws.send(JSON.stringify(end))
            } finally {
              // Don't leave a finished run's controller around — a later prompt
              // would abort()/interrupt() an already-closed query and throw.
              if (runAbort === abort) {
                runAbort = null
                runHandle = null
              }
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
    console.log(`[c3] project cwd: ${opts.projectPath}`)
    if (opts.dev) console.log(`[c3] dev mode — open Vite at http://localhost:5173`)
  })
  injectWebSocket(server)
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
