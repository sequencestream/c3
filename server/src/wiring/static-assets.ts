/**
 * Wiring — static asset handler (server refactor 3/3e-3).
 *
 * The production-only Hono handler that serves the compiled frontend bundle.
 * Two sources, in priority order:
 *  1. `STATIC_ASSETS` — Bun-embedded assets baked into the compiled binary
 *     (the `pnpm pkg` artifact).
 *  2. The filesystem fallback (`web/dist`) — used by `node cli.cjs start`
 *     in dev/non-pkg deploys.
 *
 * SPA fallback: any unmatched path serves `index.html`. The 500 message at the
 * end is the only honest failure surface — it tells the operator "you forgot
 * `pnpm build` or `pnpm pkg`", which is the most common startup failure mode.
 *
 * Behavior is byte-for-byte the same as the in-server.ts version; the handler
 * is now a single Hono `app.get('*', …)` that the assembler mounts.
 */
import type { Hono } from 'hono'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATIC_ASSETS } from '../static-embed.js'
import { mimeFor } from '../mime.js'

/** Mount the production static handler on the given Hono app. */
export function mountStaticAssets(app: Hono): void {
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
}

/** Mount the dev-mode placeholder ("open Vite at :5173"). */
export function mountDevPlaceholder(app: Hono): void {
  app.get('/', (c) => c.text('dev mode: open http://localhost:5173'))
}

function resolveStaticRoot(): string | null {
  // Filesystem fallback for `node cli.cjs start` (dev / non-pkg deploy).
  // Compiled Bun binaries serve from STATIC_ASSETS instead.
  // In the shipped CJS/Bun artifact `__dirname` is always defined, so the
  // `import.meta.url` branch never runs there; esbuild rewrites it to `undefined`
  // and the empty-import-meta warning is silenced in build.mjs. Under the ESM dev
  // runtime `__dirname` is undefined and the real module URL resolves the root.
  // (No direct eval: Node 26 runs eval in script goal, where `import.meta` throws.)
  const here =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(String(import.meta.url)))
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
