import { build } from 'esbuild'
import { rmSync, mkdirSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'

const outDir = resolve(import.meta.dirname, 'dist')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [resolve(import.meta.dirname, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: resolve(outDir, 'cli.cjs'),
  external: [
    // Native bindings the SDK may dlopen at runtime
    '@anthropic-ai/claude-agent-sdk',
    // Runtime-selected SQLite drivers (requirements/db.ts). Marking both external
    // is mandatory: esbuild (platform node) cannot resolve `bun:sqlite`, and even
    // a dynamic import of it fails the bundle without this. `node:sqlite` is a
    // builtin, harmless to list. db.ts loads exactly one at runtime.
    'node:sqlite',
    'bun:sqlite',
  ],
  alias: {
    '@ccc/shared': resolve(import.meta.dirname, '../shared/src/index.ts'),
    '@ccc/shared/protocol': resolve(import.meta.dirname, '../shared/src/protocol.ts'),
  },
  logLevel: 'info',
  // The dev (tsx/ESM) path in server.ts reads import.meta.url via direct eval so
  // this CJS bundle doesn't statically see it. In the bundled CJS, __dirname is
  // always defined and that branch is dead code — silence the spurious warning.
  logOverride: { 'direct-eval': 'silent' },
})

chmodSync(resolve(outDir, 'cli.cjs'), 0o755)
console.log('[build] server bundle ready at dist/cli.cjs')
