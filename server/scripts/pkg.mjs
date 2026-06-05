// `pnpm binary` — native single-binary quickcut for self-use.
//
// Thin wrapper that reuses the shared primitives instead of owning a second build
// path: generate the static-embed snapshot once (Phase1), then compile the native
// target via build-target.mjs (Phase2). No finally-reset of src/ — the snapshot
// lives in dist/, so the working tree stays clean and nothing races.
// For multi-platform builds use `pnpm release:build`.
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '..')
const repoRoot = resolve(serverDir, '..')

function findBun() {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const which = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' })
  const fromPath = which.stdout?.trim()
  if (which.status === 0 && fromPath) return fromPath
  const fallback = resolve(process.env.HOME ?? '', '.bun', 'bin', 'bun')
  if (existsSync(fallback)) return fallback
  console.error('[pkg] bun not found. Install from https://bun.sh, or set BUN_BIN.')
  process.exit(1)
}

function nativeTarget() {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (!os || !arch) {
    console.error(`[pkg] unsupported native platform: ${process.platform}/${process.arch}`)
    process.exit(1)
  }
  return `${os}-${arch}`
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot })
  if (r.status !== 0) {
    console.error(`[pkg] ${cmd} ${args.join(' ')} → exit ${r.status ?? 1}`)
    process.exit(r.status ?? 1)
  }
}

// Phase1 — generate the snapshot (once). Allow BUN_TARGET / BUN_OUTFILE overrides
// for backward compat with the old single-binary invocation.
run('node', [resolve(serverDir, 'scripts', 'generate-static-embed.mjs')])

const target = process.env.BUN_TARGET
  ? process.env.BUN_TARGET.replace(/^bun-/, '').replace('darwin', 'macos')
  : nativeTarget()

const bun = findBun()
const buildTargetScript = resolve(serverDir, 'scripts', 'release', 'build-target.mjs')
const args = ['run', buildTargetScript, `--target=${target}`]
if (process.env.BUN_OUTFILE) args.push(`--outfile=${process.env.BUN_OUTFILE}`)

console.log(`[pkg] native build → ${target}`)
run(bun, args)
