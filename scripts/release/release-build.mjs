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
import { computeVersionInfo } from './version-info.mjs'
import { buildManifest, writeManifest } from './manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

const HARDEN_TIERS = ['none', 'basic', 'standard']

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

// Harden tier: --harden flag > RELEASE_HARDEN env > 'basic' (release 2/7).
// `||` so an empty string (set-but-blank env) falls through to the default.
const harden = String(args.harden || process.env.RELEASE_HARDEN || 'basic')
if (!HARDEN_TIERS.includes(harden)) {
  console.error(`[release:build] unknown harden tier: ${harden}`)
  console.error(`[release:build] known: ${HARDEN_TIERS.join(', ')}`)
  process.exit(1)
}

// Compute the version info ONCE here so every target (and the manifest) share one
// version/commit/build-time. SoT is the git tag; package.json is the fallback baseline.
const versionInfo = computeVersionInfo()
// Manifest is a multi-artifact distribution-trust record — emitted for basic/standard,
// skipped for none.
const emitManifest = harden !== 'none'
const manifestPath = resolve(repoRoot, 'dist', 'manifest.json')

const embedPath = resolve(repoRoot, 'dist', 'static-embed.generated.ts')
const buildTargetScript = resolve(repoRoot, 'server', 'scripts', 'release', 'build-target.mjs')

const plan = targets.map((t) => ({
  target: t,
  outfile: resolve(repoRoot, 'dist', `c3-${t}`),
}))

console.log('[release:build] plan:')
console.log(`  version  ${versionInfo.version} (commit ${versionInfo.commit})`)
console.log(`  harden   ${harden}`)
console.log(`  manifest ${emitManifest ? `write → ${manifestPath}` : 'skipped (harden=none)'}`)
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
        `--harden=${harden}`,
        `--version-str=${versionInfo.version}`,
        `--commit=${versionInfo.commit}`,
        `--build-time=${versionInfo.buildTime}`,
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

// Manifest (release 2/7) — per-artifact sha256 + provenance, for verify-now trust.
if (emitManifest) {
  const manifest = buildManifest({
    versionInfo,
    harden,
    artifacts: plan.map((p) => ({ target: p.target, file: p.outfile })),
  })
  writeManifest(manifestPath, manifest)
  console.log(`\n[release:build] manifest → ${manifestPath}`)
  for (const a of manifest.artifacts) console.log(`  ${a.target}  ${a.sha256}  (${a.bytes}B)`)
}
