// pnpm release — interactive local release: prompt for a version, cross-compile the
// three shipping targets on THIS host (no Docker, no GH Actions), and collect the
// packages under dist/release-artifacts/v<ver>/.
//
// Bun cross-compiles every target from one macOS/Linux host, so a single machine
// produces the linux-x64 + macos-arm64 + windows-x64 set. Windows in particular needs
// no Windows runner and no container — `bun --compile --target=bun-windows-x64` writes
// c3.exe directly.
//
// Flow:
//   1. version   — prompt (or --version); normalized to X.Y.Z and validated
//   2. gate      — source pregate (typecheck/lint/test/…); --skip-gate to bypass
//   3. build     — release-build.mjs --targets=<three>  (dist/c3-v<ver>-<target>.{tar.gz,zip})
//   4. checksum  — SHA256SUMS + per-package .sha256
//   5. collect   — copy the package set + sidecars + manifest.json into
//                  dist/release-artifacts/v<ver>/
//
// 分发经公开 GitHub Release,完整性由 sha256 校验和 + GitHub HTTPS 提供。
// 发布经 CI 的 GitHub Release(`pnpm release:github`)。
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { runPregate } from './pregate.mjs'
import { computeVersionInfo } from './version-info.mjs'
import { normalizeVersion } from './artifact-name.mjs'
import { artifactsFromManifest, checksumArtifacts } from './checksum.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

// The three targets this local flow always ships. All cross-compile from one host.
const RELEASE_TARGETS = ['linux-x64', 'macos-arm64', 'windows-x64']

function parseArgs(argv) {
  const o = { passthrough: [] }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const [, k, v] = m
    if (k === 'dry-run') o.dryRun = true
    else if (k === 'skip-gate') o.skipGate = true
    else if (k === 'yes') o.yes = true
    else if (k === 'version') o.version = v
    else if (k === 'targets') o.targets = v
    else if (['skip-web', 'skip-smoke', 'skip-pack'].includes(k)) o.passthrough.push(a)
  }
  return o
}

function run(script, scriptArgs) {
  return new Promise((res, rej) => {
    const p = spawn('node', [resolve(here, script), ...scriptArgs], {
      stdio: 'inherit',
      cwd: repoRoot,
    })
    p.on('error', rej)
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${script} → exit ${code}`))))
  })
}

/** A version is X.Y.Z with an optional prerelease/build tail; a single leading `v` is tolerated. */
function isValidVersion(v) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalizeVersion(v))
}

/** Resolve the release version: --version wins; otherwise prompt with the baseline as default. */
async function resolveVersion(args) {
  if (args.version) {
    const v = normalizeVersion(args.version.trim())
    if (!isValidVersion(v))
      throw new Error(`--version "${args.version}" is not a valid X.Y.Z version`)
    return v
  }
  if (!process.stdin.isTTY)
    throw new Error(
      'no TTY to prompt for a version — pass --version=X.Y.Z in non-interactive runs.',
    )

  const suggested = computeVersionInfo().version
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = (await rl.question(`Release version [${suggested}]: `)).trim()
      const v = normalizeVersion(answer || suggested)
      if (isValidVersion(v)) return v
      console.log(`  ✗ "${answer}" is not a valid version (expected X.Y.Z). Try again.`)
    }
  } finally {
    rl.close()
  }
}

/** The upload set for a release: every package + its .sha256 sidecar + the aggregate index files. */
function collectFiles(manifest) {
  const files = []
  for (const a of manifest.artifacts) {
    const name = a.file
    files.push(name, `${name}.sha256`)
  }
  files.push('SHA256SUMS', 'manifest.json')
  return files
}

/** Copy the built package set from dist/ into dist/release-artifacts/v<ver>/ (flat layout). */
function collectArtifacts(distDir, outDir, manifest, log) {
  mkdirSync(outDir, { recursive: true })
  const copied = []
  for (const name of collectFiles(manifest)) {
    const src = resolve(distDir, name)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(outDir, name))
    copied.push(name)
  }
  log(`  collected ${copied.length} file(s) → ${outDir}`)
  return copied
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const targets = args.targets
    ? args.targets
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : RELEASE_TARGETS

  const version = await resolveVersion(args)
  const tag = `v${version}`
  // Thread the chosen version to every child so the packages / manifest all stamp it.
  process.env.C3_RELEASE_VERSION = version

  const distDir = resolve(repoRoot, 'dist')
  const outDir = resolve(distDir, 'release-artifacts', tag)

  console.log(
    `[release] ${args.dryRun ? 'DRY-RUN ' : ''}${tag} — ` +
      `gate → build(${targets.join(',')}) → checksum → collect`,
  )
  console.log(`[release]   out ${outDir}`)

  // 1. pregate — blocking source gate; skip with --skip-gate, list-only with --dry-run.
  if (!args.skipGate) {
    const { failed } = runPregate({ dryRun: args.dryRun })
    if (failed) {
      console.error(
        `[release] aborted — source gate "${failed}" is red (no cross-compile attempted).`,
      )
      process.exit(1)
    }
  } else {
    console.log('[release] --skip-gate: source gates skipped.')
  }

  if (args.dryRun) {
    console.log('[release] --dry-run: would build + checksum + collect into', outDir)
    console.log('[release] --dry-run: publish to a GitHub Release with `pnpm release:github`.')
    return
  }

  // 2. build the three targets (Phase0 web → Phase1 embed → Phase2 cross-compile → pack).
  await run('release-build.mjs', [`--targets=${targets.join(',')}`, ...args.passthrough])

  // 3. checksum in place — SHA256SUMS + per-package .sha256.
  const manifestPath = resolve(distDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`build produced no manifest at ${manifestPath}.`)
  const { artifacts } = artifactsFromManifest(manifestPath)
  console.log('\n[release] hashing…')
  checksumArtifacts({
    artifacts,
    outDir: distDir,
    version,
    log: (m) => console.log(m),
  })

  // 4. collect into dist/release-artifacts/v<ver>/ (flat layout).
  console.log('\n[release] collecting…')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  collectArtifacts(distDir, outDir, manifest, (m) => console.log(m))

  // Packages are ready. Publish them to a public GitHub Release with `pnpm release:github`.
  console.log(`\n[release] packages ready at ${outDir}`)
  console.log('[release] publish with: pnpm release:github')

  console.log(`\n[release] done — ${tag} at ${outDir}`)
}

main().catch((err) => {
  console.error(`[release] ✗ ${err.message}`)
  process.exit(1)
})
