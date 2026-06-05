// Single-target Bun compile — the one reusable build primitive.
//
// Runs under `bun` (uses the Bun.build JS API). Produces ONE standalone executable
// for ONE platform target. Pure reader of the pre-generated static-embed snapshot:
// the import of `../static-embed.js` (the committed empty stub) is redirected at
// build time to the generated dist/static-embed.generated.ts via an onResolve
// plugin, so N targets can build in parallel without writing any shared file.
//
// `pnpm binary` (native, self-use) and `pnpm release:build` (multi-platform) both
// route through buildTarget() — no second compile path.
//
/* global Bun */
// ^ This module runs under `bun` (Bun.build JS API); `Bun` is a runtime global.
import { chmodSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeVersionInfo, versionDefines } from '../../../scripts/release/version-info.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '..', '..') // server/
const repoRoot = resolve(serverDir, '..')

// Hardening tiers (release 2/7) — govern the native binary build only. Motivation is
// distribution trust >> obfuscation; standard is a SPEC-GATED placeholder (see
// specs/non-functional/release.md "Hardening tiers"): no spec entry → no standard tier,
// so it currently builds with basic behavior and warns. None ≈ the tsx dev path.
export const HARDEN_TIERS = {
  none: { minify: false, sourcemap: 'inline' },
  basic: { minify: true, sourcemap: 'none' },
  standard: { minify: true, sourcemap: 'none' }, // placeholder == basic; no obfuscation yet
}

export function resolveHarden(harden) {
  if (!(harden in HARDEN_TIERS)) {
    throw new Error(
      `[build-target] unknown harden tier "${harden}"; known: ${Object.keys(HARDEN_TIERS).join(', ')}`,
    )
  }
  if (harden === 'standard') {
    console.warn(
      '[build-target] harden="standard" has no spec entry yet — building with BASIC behavior ' +
        '(no obfuscation). See release.md "no spec entry, no standard tier".',
    )
  }
  return HARDEN_TIERS[harden]
}

// Friendly target name → Bun --target triple. P0 wave: macOS-arm64 + Linux-x64-glibc.
export const TARGETS = {
  'macos-arm64': 'bun-darwin-arm64',
  'linux-x64': 'bun-linux-x64',
}

export function defaultOutfile(friendly) {
  return resolve(repoRoot, 'dist', `c3-${friendly}`)
}

export function defaultEmbedPath() {
  return resolve(repoRoot, 'dist', 'static-embed.generated.ts')
}

// macOS ad-hoc code signing (release 3/7). MUST run before any sha256/minisign — codesign
// rewrites the Mach-O, so hashing a signed binary is the only way manifest/.sha256/.minisig
// stay consistent (that's why this lives in the compile primitive, not the sign step).
// Best-effort and three-gated: macOS target + darwin host + codesign present. Cross-building
// a mac binary on a non-mac host can't ad-hoc sign — warn and leave it to a mac runner. `-s -`
// is ad-hoc (no certificate, zero cost); it does NOT clear Gatekeeper quarantine (see README
// `xattr -dr com.apple.quarantine`).
function adHocCodesign(out, friendly) {
  if (!friendly.startsWith('macos')) return
  if (process.platform !== 'darwin') {
    console.warn(
      `[build-target] ${friendly}: skip ad-hoc codesign (host is ${process.platform}, not darwin — sign on a mac runner)`,
    )
    return
  }
  const probe = spawnSync('sh', ['-c', 'command -v codesign'], { encoding: 'utf-8' })
  if (probe.status !== 0) {
    console.warn(`[build-target] ${friendly}: skip ad-hoc codesign (codesign not found)`)
    return
  }
  const res = spawnSync('codesign', ['--force', '--sign', '-', out], { encoding: 'utf-8' })
  if (res.status === 0) {
    console.log(`[build-target] ${friendly}: ad-hoc codesigned`)
  } else {
    console.warn(
      `[build-target] ${friendly}: ad-hoc codesign failed (${(res.stderr || '').trim()}) — continuing unsigned`,
    )
  }
}

/**
 * Compile one target.
 * @param {object} o
 * @param {string} o.target   friendly name (key of TARGETS) or a raw bun-* triple
 * @param {string} [o.outfile]   absolute output path (default dist/c3-<friendly>)
 * @param {string} [o.embedPath] absolute path to the generated static-embed snapshot
 * @param {string} [o.harden]    hardening tier — none | basic (default) | standard
 * @param {string} [o.version]   injected version (else computed from git tag / baseline)
 * @param {string} [o.commit]    injected short commit (else computed)
 * @param {string} [o.buildTime] injected ISO build time (else now)
 */
export async function buildTarget({
  target,
  outfile,
  embedPath,
  harden = 'basic',
  version,
  commit,
  buildTime,
}) {
  const bunTarget = TARGETS[target] ?? target
  const friendly =
    Object.keys(TARGETS).find((k) => TARGETS[k] === bunTarget) ??
    target.replace(/^bun-/, '').replace('darwin', 'macos')
  const out = outfile ?? defaultOutfile(friendly)
  const embed = embedPath ?? defaultEmbedPath()
  const entry = resolve(serverDir, 'src', 'cli.ts')

  const tier = resolveHarden(harden)
  // Use the threaded-down version info when present (orchestrator computes it once so
  // every artifact shares one build time); otherwise compute locally (standalone run).
  const info = computeVersionInfo({ buildTime })
  if (version) info.version = version
  if (commit) info.commit = commit

  if (!existsSync(embed)) {
    throw new Error(
      `[build-target] embed snapshot missing: ${embed}\n` +
        `  Run Phase1 first: \`node server/scripts/generate-static-embed.mjs\` (needs web/dist/).`,
    )
  }

  // Redirect the committed stub import to the real generated snapshot. The asset
  // imports INSIDE the snapshot (web/dist/**) are NOT matched and resolve normally.
  const redirectStub = {
    name: 'static-embed-redirect',
    setup(build) {
      build.onResolve({ filter: /static-embed(\.js)?$/ }, () => ({ path: embed }))
    },
  }

  console.log(
    `[build-target] target=${friendly} (${bunTarget}) harden=${harden} → ${out} ` +
      `[v${info.version} ${info.commit}]`,
  )
  // NB: --bytecode is intentionally never enabled — cross-compile + bytecode segfaults
  // (oven-sh/bun#18416). Bun.build defaults bytecode off. minify/sourcemap come from the
  // harden tier; version constants are injected via define.
  const result = await Bun.build({
    entrypoints: [entry],
    target: bunTarget,
    minify: tier.minify,
    sourcemap: tier.sourcemap,
    define: versionDefines(info),
    compile: { target: bunTarget, outfile: out },
    plugins: [redirectStub],
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`[build-target] bun build failed for ${friendly}`)
  }
  if (!existsSync(out)) {
    throw new Error(`[build-target] outfile missing after build: ${out}`)
  }
  chmodSync(out, 0o755)
  adHocCodesign(out, friendly) // before any hashing/signing — codesign mutates the binary
  console.log(`[build-target] OK → ${out}`)
  return { friendly, bunTarget, outfile: out }
}

// ── CLI entry: `bun run build-target.mjs --target=macos-arm64 [--outfile=...] [--embed=...]`
function parseArgs(argv) {
  const o = {}
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) o[m[1]] = m[2]
    else if (a.startsWith('--')) o[a.slice(2)] = true
  }
  return o
}

const isMain = (() => {
  try {
    return import.meta.path === Bun.main
  } catch {
    return false
  }
})()

if (isMain) {
  const a = parseArgs(process.argv.slice(2))
  const target = a.target ?? process.env.BUN_TARGET ?? 'macos-arm64'
  await buildTarget({
    target,
    outfile: a.outfile ? resolve(a.outfile) : undefined,
    embedPath: a.embed ? resolve(a.embed) : undefined,
    harden: a.harden || process.env.RELEASE_HARDEN || 'basic',
    version: a['version-str'],
    commit: a.commit,
    buildTime: a['build-time'],
  })
}
