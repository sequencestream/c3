// Drive the Bun single-binary build:
//   1. Generate server/src/static-embed.ts with real `web/dist/**` imports.
//   2. Run `bun build --compile --target=...` against src/cli.ts.
//   3. Always reset static-embed.ts back to an empty stub so the working tree
//      stays clean and esbuild (used by `pnpm build`) doesn't trip on
//      Bun-specific `with { type: 'text' }` import attributes.
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, chmodSync, existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '..')
const repoRoot = resolve(serverDir, '..')
const stubPath = resolve(serverDir, 'src', 'static-embed.ts')

const STUB = `// AUTO-GENERATED stub by server/scripts/pkg.mjs (post-pkg reset)
export const STATIC_ASSETS: ReadonlyMap<string, { body: string; mime: string }> = new Map();
`

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: serverDir, ...opts })
  if (r.status !== 0) {
    const code = r.status ?? 1
    process.exitCode = code
    throw new Error(`[pkg] ${cmd} ${args.join(' ')} → exit ${code}`)
  }
}

function findBun() {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const which = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' })
  const fromPath = which.stdout?.trim()
  if (which.status === 0 && fromPath) return fromPath
  const home = process.env.HOME ?? ''
  const fallback = resolve(home, '.bun', 'bin', 'bun')
  if (existsSync(fallback)) return fallback
  console.error('[pkg] bun not found. Install from https://bun.sh, or set BUN_BIN.')
  process.exit(1)
}

const target = process.env.BUN_TARGET || 'bun-darwin-arm64'
const outfile =
  process.env.BUN_OUTFILE ||
  resolve(repoRoot, 'dist', `c3-${target.replace(/^bun-/, '').replace('darwin', 'macos')}`)

try {
  run('node', ['scripts/generate-static-embed.mjs'])
  const bun = findBun()
  console.log(`[pkg] bun = ${bun}`)
  console.log(`[pkg] target = ${target}`)
  console.log(`[pkg] outfile = ${outfile}`)
  run(bun, [
    'build',
    '--compile',
    `--target=${target}`,
    '--minify',
    '--outfile',
    outfile,
    'src/cli.ts',
  ])
  if (existsSync(outfile)) {
    chmodSync(outfile, 0o755)
    console.log(`[pkg] OK → ${outfile}`)
  } else {
    console.error(`[pkg] outfile missing after bun build: ${outfile}`)
    process.exit(1)
  }
} finally {
  writeFileSync(stubPath, STUB)
  console.log('[pkg] reset static-embed.ts to empty stub')
}
