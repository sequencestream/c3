import { build } from 'esbuild'
import { rmSync, mkdirSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeVersionInfo, versionDefines } from '../scripts/release/version-info.mjs'

const outDir = resolve(import.meta.dirname, 'dist')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// Version injection (release 2/7). This is the node bundle (`pnpm start`); only the
// version defines apply here — minify/sourcemap are left as-is.
await build({
  entryPoints: [resolve(import.meta.dirname, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: resolve(outDir, 'cli.cjs'),
  define: {
    ...versionDefines(computeVersionInfo()),
    // esbuild rewrites `import.meta.url` to an empty object in CJS output, so any
    // dependency that runs `createRequire(import.meta.url)` at module load (e.g.
    // @openai/codex-sdk) gets `undefined` and throws on Node 26
    // (`createRequire(undefined)` no longer tolerated). Point it at a real file URL
    // derived from __filename. Our own db.ts / static-assets.ts import.meta.url
    // branches stay dead because their `require`/`__dirname` ternaries short-circuit
    // first, so this only fixes the dependency path.
    'import.meta.url': 'importMetaUrl',
  },
  banner: {
    js: "const importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  external: [
    // Native bindings the SDK may dlopen at runtime
    '@anthropic-ai/claude-agent-sdk',
    // Sandbox Docker driver (ADR-0024). dockerode pulls in ssh2 → cpu-features,
    // which ships a native `.node` esbuild can't bundle. Keep it external so it
    // loads from node_modules at runtime (a direct @ccc/server dependency).
    'dockerode',
    // Runtime-selected SQLite drivers (db.ts). Marking both external
    // is mandatory: esbuild (platform node) cannot resolve `bun:sqlite`, and even
    // a dynamic import of it fails the bundle without this. `node:sqlite` is a
    // builtin, harmless to list. db.ts loads exactly one at runtime.
    'node:sqlite',
    'bun:sqlite',
  ],
  alias: {
    '@ccc/shared': resolve(import.meta.dirname, '../shared/src'),
    '@ccc/shared/protocol': resolve(import.meta.dirname, '../shared/src/protocol.ts'),
    '@ccc/shared/discussion-types': resolve(
      import.meta.dirname,
      '../shared/src/discussion-types.ts',
    ),
    '@ccc/shared/cron': resolve(import.meta.dirname, '../shared/src/cron.ts'),
    '@ccc/shared/nl-cron': resolve(import.meta.dirname, '../shared/src/nl-cron.ts'),
  },
  logLevel: 'info',
  // Any bare `import.meta` (without `.url`) still resolves to `{}` in CJS; that's
  // fine for our remaining dead branches, so keep the warning silenced.
  logOverride: { 'empty-import-meta': 'silent' },
})

chmodSync(resolve(outDir, 'cli.cjs'), 0o755)
console.log('[build] server bundle ready at dist/cli.cjs')
