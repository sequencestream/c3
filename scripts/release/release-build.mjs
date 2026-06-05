// release:build — the thin multi-platform orchestrator (build only, no publish).
//
// Three explicit phases, by design, to kill the parallel race that the old
// per-target pkg.mjs had (it wrote+reset a shared src/ file in a finally):
//
//   Phase0  web build          — once, platform-independent  (pnpm -F @ccc/web build)
//   Phase1  generate-static-embed — once, writes dist/static-embed.generated.ts
//   Phase2  fan-out compile     — N targets in PARALLEL, each a pure reader of the
//                                 Phase1 snapshot (bun run build-target.mjs)
//
// Phase2 never writes a shared file, so the working tree stays clean and targets
// cannot stomp each other. CI and local share this exact script.
//
// Usage:
//   node scripts/release/release-build.mjs [--targets=macos-arm64,linux-x64] [--dry-run] [--skip-web]
import { spawn, spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

// Keep this list in sync with TARGETS in server/scripts/release/build-target.mjs.
const KNOWN_TARGETS = ['macos-arm64', 'linux-x64']
const DEFAULT_TARGETS = ['macos-arm64', 'linux-x64']

function parseArgs(argv) {
  const o = {}
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) o[m[1]] = m[2]
    else if (a.startsWith('--')) o[a.slice(2)] = true
  }
  return o
}

function findBun() {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const which = spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' })
  const fromPath = which.stdout?.trim()
  if (which.status === 0 && fromPath) return fromPath
  const fallback = resolve(process.env.HOME ?? '', '.bun', 'bin', 'bun')
  if (existsSync(fallback)) return fallback
  console.error('[release:build] bun not found. Install from https://bun.sh, or set BUN_BIN.')
  process.exit(1)
}

function run(cmd, args, label) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: repoRoot })
    p.on('error', rej)
    p.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`[release:build] ${label} → exit ${code}`)),
    )
  })
}

const args = parseArgs(process.argv.slice(2))
const targets = (args.targets ? String(args.targets).split(',') : DEFAULT_TARGETS)
  .map((t) => t.trim())
  .filter(Boolean)

const unknown = targets.filter((t) => !KNOWN_TARGETS.includes(t))
if (unknown.length) {
  console.error(`[release:build] unknown target(s): ${unknown.join(', ')}`)
  console.error(`[release:build] known: ${KNOWN_TARGETS.join(', ')}`)
  process.exit(1)
}

const embedPath = resolve(repoRoot, 'dist', 'static-embed.generated.ts')
const buildTargetScript = resolve(repoRoot, 'server', 'scripts', 'release', 'build-target.mjs')

const plan = targets.map((t) => ({
  target: t,
  outfile: resolve(repoRoot, 'dist', `c3-${t}`),
}))

console.log('[release:build] plan:')
console.log(`  Phase0  web build${args['skip-web'] ? ' (skipped)' : ''}`)
console.log('  Phase1  generate-static-embed → dist/static-embed.generated.ts')
console.log(`  Phase2  compile (parallel): ${plan.map((p) => p.target).join(', ')}`)
for (const p of plan) console.log(`            ${p.target} → ${p.outfile}`)

if (args['dry-run']) {
  console.log('[release:build] --dry-run: nothing executed.')
  process.exit(0)
}

const bun = findBun()

// Phase0 — web build (once, platform-independent)
if (!args['skip-web']) {
  console.log('\n[release:build] Phase0 — web build')
  await run('pnpm', ['-F', '@ccc/web', 'build'], 'web build')
}

// Phase1 — generate static-embed snapshot (once)
console.log('\n[release:build] Phase1 — generate-static-embed')
await run(
  'node',
  [resolve(repoRoot, 'server', 'scripts', 'generate-static-embed.mjs')],
  'generate-static-embed',
)

// Phase2 — fan-out compile (parallel, read-only on the snapshot)
console.log('\n[release:build] Phase2 — compile (parallel)')
const results = await Promise.allSettled(
  plan.map((p) =>
    run(
      bun,
      [
        'run',
        buildTargetScript,
        `--target=${p.target}`,
        `--outfile=${p.outfile}`,
        `--embed=${embedPath}`,
      ],
      `compile ${p.target}`,
    ),
  ),
)

const failed = results
  .map((r, i) => ({ r, t: plan[i].target }))
  .filter((x) => x.r.status === 'rejected')

if (failed.length) {
  for (const f of failed)
    console.error(`[release:build] FAILED: ${f.t} — ${f.r.reason?.message ?? f.r.reason}`)
  process.exit(1)
}

console.log('\n[release:build] OK — all targets built:')
for (const p of plan) console.log(`  ${p.target} → ${p.outfile}`)
