// release:build — the thin multi-platform orchestrator (build only, no publish).
//
// Four explicit phases, by design, to kill the parallel race that the old
// per-target pkg.mjs had (it wrote+reset a shared src/ file in a finally):
//
//   Phase0  web build          — once, platform-independent  (pnpm -F @ccc/web build)
//   Phase1  generate-static-embed — once, writes dist/static-embed.generated.ts
//   Phase2  fan-out compile     — N targets in PARALLEL, each a pure reader of the
//                                 Phase1 snapshot (bun run build-target.mjs).
//                                 Output: dist/<target>/c3 (or c3.exe on Windows).
//                                 The per-target subdir is internal scratch and
//                                 NEVER uploaded — it exists only to keep parallel
//                                 targets from clobbering one another.
//   Phase2.5 pack               — wrap each dist/<target>/c3 (+ inner sidecars) into
//                                 dist/c3-v{ver}-{target}.{tar.gz|zip}. The package
//                                 is the unit of distribution; its name is the only
//                                 place the version + platform info lives.
//
// Phase2 never writes a shared file, so the working tree stays clean and targets
// cannot stomp each other. CI and local share this exact script.
//
// Usage:
//   node scripts/release/release-build.mjs [--targets=macos-arm64,linux-x64] [--dry-run] [--skip-web] [--skip-pack]
import { spawn, spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { computeVersionInfo } from './version-info.mjs'
import { buildManifest, writeManifest } from './manifest.mjs'
import { binaryName } from './artifact-name.mjs'
import { KNOWN_TARGETS, DEFAULT_TARGETS, isExperimental } from './targets.mjs'
import { smokeBuiltArtifacts } from './smoke.mjs'
import { packOne } from './pack.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

const HARDEN_TIERS = ['none', 'basic', 'standard']

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
  // Windows has no `sh`; use `where bun` there (release 4/7 — windows-latest must build).
  const isWin = process.platform === 'win32'
  const which = isWin
    ? spawnSync('where', ['bun'], { encoding: 'utf-8' })
    : spawnSync('sh', ['-c', 'command -v bun'], { encoding: 'utf-8' })
  const fromPath = which.stdout?.split('\n')[0]?.trim()
  if (which.status === 0 && fromPath) return fromPath
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const fallback = isWin
    ? resolve(home, '.bun', 'bin', 'bun.exe')
    : resolve(home, '.bun', 'bin', 'bun')
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
// skipped for none. Pack is the consumer-facing distribution unit; it's always
// produced for basic/standard. `none` is debug — no manifest, no pack.
const emitManifest = harden !== 'none'
const emitPack = harden !== 'none' && !args['skip-pack']
const manifestPath = resolve(repoRoot, 'dist', 'manifest.json')

const embedPath = resolve(repoRoot, 'dist', 'static-embed.generated.ts')
const buildTargetScript = resolve(repoRoot, 'server', 'scripts', 'release', 'build-target.mjs')

// Build plan — `outfile` is the BINARY path (dist/<target>/c3). The package
// path is computed by packOne from version + target.
const plan = targets.map((t) => ({
  target: t,
  outfile: resolve(repoRoot, 'dist', t, binaryName(t)),
  experimental: isExperimental(t),
}))

console.log('[release:build] plan:')
console.log(`  version  ${versionInfo.version} (commit ${versionInfo.commit})`)
console.log(
  `  harden   ${harden}${harden === 'standard' ? ' (string-array + identifier-rename; fallback = bare compile on failure)' : ''}`,
)
console.log(`  manifest ${emitManifest ? `write → ${manifestPath}` : 'skipped (harden=none)'}`)
console.log(
  `  pack     ${emitPack ? `dist/c3-v{ver}-{target}{.tar.gz|.zip}` : 'skipped (harden=none or --skip-pack)'}`,
)
console.log(`  Phase0  web build${args['skip-web'] ? ' (skipped)' : ''}`)
console.log('  Phase1  generate-static-embed → dist/static-embed.generated.ts')
console.log(
  `  Phase2  bundle${harden === 'standard' ? ' → obfuscate' : ''} → compile (parallel): ${plan.map((p) => p.target).join(', ')}`,
)
for (const p of plan)
  console.log(
    `            ${p.target}${p.experimental ? ' ⚠️experimental' : ''} → ${p.outfile} (binary: ${binaryName(p.target)})`,
  )
console.log(
  `  Phase2.5 pack${args['skip-pack'] ? ' (skipped)' : ''} → dist/c3-v${versionInfo.version}-{target}{.tar.gz|.zip}`,
)
console.log(
  `  Phase3  artifact gate (--version + headless smoke)${args['skip-smoke'] ? ' (skipped)' : ', host-runnable targets only'}`,
)

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
const stageDir = resolve(repoRoot, 'dist', '.obf-stage')
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
    ).then(() => {
      // Read the per-target sidecar that buildTarget writes to
      // dist/.obf-stage/<target>.result.json. It carries the obfuscation result
      // (release 7/7) so the manifest can stamp it for audit. The sidecar is
      // optional — if it's missing (older buildTarget, or buildTarget decided
      // not to write one), we default to obfuscated:false.
      const rp = resolve(stageDir, `${p.target}.result.json`)
      if (!existsSync(rp)) return { obfuscated: false, obfDurationMs: 0 }
      try {
        return JSON.parse(readFileSync(rp, 'utf-8'))
      } catch {
        return { obfuscated: false, obfDurationMs: 0 }
      }
    }),
  ),
)

const failed = results
  .map((r, i) => ({ r, t: plan[i].target, experimental: plan[i].experimental }))
  .filter((x) => x.r.status === 'rejected')

// Experimental targets (release 4/7) are BEST-EFFORT: a failed experimental build
// (e.g. windows cross-compile hiccup) warns and is dropped — it MUST NOT block the
// P0 release. Only a non-experimental failure aborts.
const experimentalFailed = failed.filter((f) => f.experimental)
const blockingFailed = failed.filter((f) => !f.experimental)

for (const f of experimentalFailed)
  console.warn(
    `[release:build] ⚠️ experimental target ${f.t} failed — dropping (does NOT block release): ` +
      `${f.r.reason?.message ?? f.r.reason}`,
  )

if (blockingFailed.length) {
  for (const f of blockingFailed)
    console.error(`[release:build] FAILED: ${f.t} — ${f.r.reason?.message ?? f.r.reason}`)
  process.exit(1)
}

// The targets that actually produced an artifact — drop dropped experimentals so the
// manifest, pack, and smoke gate only see real outputs.
const builtPlan = plan
  .filter((p) => !experimentalFailed.some((f) => f.t === p.target))
  .map((p) => {
    // Find the matching fulfilled result; default obfuscated:false on miss.
    const r = results[plan.indexOf(p)]
    const obf = r.status === 'fulfilled' ? r.value : { obfuscated: false, obfDurationMs: 0 }
    return { ...p, obfuscated: obf.obfuscated === true, obfDurationMs: obf.obfDurationMs ?? 0 }
  })

console.log('\n[release:build] OK — all targets built:')
for (const p of builtPlan) {
  const obfTag = harden === 'standard' ? ` obfuscated=${p.obfuscated}` : ''
  console.log(
    `  ${p.target}${p.experimental ? ' ⚠️experimental' : ''} → ${p.outfile} (binary: ${binaryName(p.target)})${obfTag}`,
  )
}

// Phase2.5 — pack (release: package each built target's binary + inner sidecars
// into a distributable archive: dist/c3-v{ver}-{target}{.tar.gz|.zip}). Skipped
// for `harden=none` (debug) and when `--skip-pack` is set.
let packages = []
if (emitPack) {
  console.log('\n[release:build] Phase2.5 — pack (dist/c3-v{ver}-{target}.{tar.gz|zip})')
  for (const p of builtPlan) {
    try {
      const pk = packOne({
        target: p.target,
        version: versionInfo.version,
        distDir: resolve(repoRoot, 'dist'),
        log: (m) => console.log(m),
      })
      packages.push({
        target: p.target,
        experimental: p.experimental,
        obfuscated: p.obfuscated,
        obfDurationMs: p.obfDurationMs,
        file: pk.package,
        binary: pk.binary,
        bytes: pk.bytes,
        innerSha256: pk.sha256,
        signed: pk.signed,
      })
    } catch (err) {
      console.error(`[release:build] pack failed for ${p.target}: ${err.message}`)
      if (!p.experimental) process.exit(1)
      console.warn(
        `[release:build] ⚠️ experimental target ${p.target} pack failed — dropping (does NOT block release)`,
      )
    }
  }
}

// Manifest (release 2/7, obfuscation block added 7/7) — per-artifact sha256 + provenance,
// for verify-now trust. The `file` field is the PACKAGE name (the upload unit); the
// `binary` field is the in-package binary name (`c3` / `c3.exe`).
if (emitManifest) {
  // The manifest is the single source of truth for sign/publish. The artifacts
  // it lists are the packages. If packing was skipped, the manifest still has
  // to record something — fall back to the bare binary path so the downstream
  // sign/publish steps have a non-empty list (this is a debug build anyway).
  const manifestArtifacts = emitPack
    ? packages.map((p) => ({
        target: p.target,
        file: p.file,
        binary: p.binary,
        binarySha256: p.innerSha256, // sha256 of the IN-PACKAGE binary
        bytes: p.bytes,
        sha256: p.sha256, // sha256 of the PACKAGE (matches SHA256SUMS line)
        experimental: p.experimental,
        obfuscated: p.obfuscated,
        obfDurationMs: p.obfDurationMs,
      }))
    : builtPlan.map((p) => ({
        target: p.target,
        file: p.outfile,
        bytes: 0,
        sha256: '',
        experimental: p.experimental,
        obfuscated: p.obfuscated,
        obfDurationMs: p.obfDurationMs,
      }))

  const manifest = buildManifest({
    versionInfo,
    harden,
    artifacts: manifestArtifacts,
  })
  writeManifest(manifestPath, manifest)
  console.log(`\n[release:build] manifest → ${manifestPath}`)
  for (const a of manifest.artifacts) {
    const obfTag = a.obfuscation
      ? ` obf=${a.obfuscation.applied}${a.obfuscation.applied && a.obfuscation.durationMs ? ` (${a.obfuscation.durationMs}ms)` : ''}`
      : ''
    console.log(`  ${a.target}  ${a.file}  (${a.bytes}B)${obfTag}`)
  }
}

// Phase3 — artifact-level quality gate (release 5/7): for every host-runnable
// target, assert `c3 --version` and run a headless smoke (random port → HTTP
// probe → exit). Cross-compiled targets that can't execute here are skipped and
// left to their platform's CI runner. `--skip-smoke` opts out (debug builds).
// The smoke operates on the BINARY (dist/<target>/c3), not the package — the
// binary IS the same bytes as inside the tarball.
if (!args['skip-smoke']) {
  console.log('\n[release:build] Phase3 — artifact gate (--version + headless smoke)')
  await smokeBuiltArtifacts({
    artifacts: builtPlan.map((p) => ({ target: p.target, path: p.outfile })),
    log: (m) => console.log(m),
  })
}
