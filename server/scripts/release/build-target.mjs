// Single-target Bun compile — the one reusable build primitive.
//
// Runs under `bun` (uses the Bun.build JS API for the bundle pass, the bun CLI for
// the compile pass). Produces ONE standalone executable for ONE platform target.
// Pure reader of the pre-generated static-embed snapshot: the import of
// `../static-embed.js` (the committed empty stub) is redirected at build time to
// the generated dist/static-embed.generated.ts via an onResolve plugin, so N
// targets can build in parallel without writing any shared file.
//
// `pnpm binary` (native, self-use) and `pnpm release:build` (multi-platform) both
// route through buildTarget() — no second compile path.
//
// 编译路径是 bundle → compile 两步:bundle 步用 Bun.build(带 onResolve 插件把
// static-embed 占位符重定向到生成的快照)产出一个自包含的中间 JS,compile 步再由
// bun CLI 基于该中间文件产出原生二进制。两步拆分是为了让 static-embed 快照能在
// bundle 阶段内联进来,再交给 compile。
//
/* global Bun */
// ^ This module runs under `bun` (Bun.build JS API); `Bun` is a runtime global.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeVersionInfo, versionDefines } from '../../../scripts/release/version-info.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '..', '..') // server/
const repoRoot = resolve(serverDir, '..')

// Friendly target name → Bun --target triple.
//   P0 wave: macOS-arm64 + Linux-x64-glibc.
//   Experimental: Windows-x64 (ships ⚠️experimental).
// Keep in sync with KNOWN_TARGETS in scripts/release/targets.mjs.
export const TARGETS = {
  'macos-arm64': 'bun-darwin-arm64',
  'linux-x64': 'bun-linux-x64',
  'windows-x64': 'bun-windows-x64',
}

export function defaultOutfile(friendly) {
  // Binary is always named `c3` (or `c3.exe` on Windows). The per-target
  // subdir carries the platform info so parallel builds don't clobber each
  // other; the subdir is internal scratch and never uploaded (the release
  // pipeline packages it into `dist/c3-v{ver}-{target}.{tar.gz|zip}`).
  const name = friendly.startsWith('windows') ? 'c3.exe' : 'c3'
  return resolve(repoRoot, 'dist', friendly, name)
}

export function defaultEmbedPath() {
  return resolve(repoRoot, 'dist', 'static-embed.generated.ts')
}

export function defaultStageDir() {
  return resolve(repoRoot, 'dist', '.build-stage')
}

// macOS ad-hoc code signing (release 3/7). MUST run before any sha256 — codesign
// rewrites the Mach-O, so hashing a signed binary is the only way manifest/.sha256
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
 * @param {string} [o.version]   injected version (else computed from git tag / baseline)
 * @param {string} [o.commit]    injected short commit (else computed)
 * @param {string} [o.buildTime] injected ISO build time (else now)
 * @returns {Promise<{ friendly: string, bunTarget: string, outfile: string }>}
 */
export async function buildTarget({ target, outfile, embedPath, version, commit, buildTime }) {
  const bunTarget = TARGETS[target] ?? target
  const friendly =
    Object.keys(TARGETS).find((k) => TARGETS[k] === bunTarget) ??
    target.replace(/^bun-/, '').replace('darwin', 'macos')
  // Bun appends `.exe` for a windows target if the outfile lacks it. Mirror that here
  // so the post-build `existsSync(out)` check (and the returned path) match what Bun
  // actually writes — otherwise a standalone windows build would "fail" on a present file.
  let out = outfile ?? defaultOutfile(friendly)
  if (friendly.startsWith('windows') && !out.toLowerCase().endsWith('.exe')) out += '.exe'
  const embed = embedPath ?? defaultEmbedPath()
  const entry = resolve(serverDir, 'src', 'cli.ts')

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

  // --bytecode is intentionally OFF: it requires a CommonJS bundle, but our staged bundle is
  // ESM, so `bun --compile --bytecode` produces a binary that aborts at startup with
  // "Expected CommonJS module to have a function wrapper". Bytecode is only a startup-time
  // perf cache (not anti-tamper), so we skip it rather than convert the bundle to CJS.
  console.log(
    `[build-target] target=${friendly} (${bunTarget}) → ${out} ` +
      `[v${info.version} ${info.commit}] bytecode=off`,
  )

  // ── Phase 1: Bundle. Produce a self-contained intermediate JS in dist/.build-stage/
  //    so the static-embed snapshot is inlined before compile. The stage dir is
  //    gitignored; it's scratch space, never archived.
  const stageDir = defaultStageDir()
  const stagePath = resolve(stageDir, `${friendly}.js`)

  // The stage bundle is intentionally NOT minified here. Re-running `bun build
  // --compile` (Phase 2) over an already-minified single file mangles Zod's
  // method dispatch and produces a binary that throws `e5 is not a function` at
  // startup. Minification is deferred to the compile step (Phase 2), which works
  // correctly on readable input.
  const bundleResult = await Bun.build({
    entrypoints: [entry],
    target: bunTarget,
    minify: false,
    sourcemap: 'none',
    define: versionDefines(info),
    plugins: [redirectStub],
  })

  if (!bundleResult.success) {
    for (const log of bundleResult.logs) console.error(log)
    throw new Error(`[build-target] bun bundle failed for ${friendly}`)
  }
  if (bundleResult.outputs.length === 0) {
    throw new Error(`[build-target] bun bundle produced no outputs for ${friendly}`)
  }

  mkdirSync(stageDir, { recursive: true })
  await Bun.write(stagePath, bundleResult.outputs[0])

  // ── Phase 2: Compile the bundle to a native binary.
  //    Spawn the bun CLI on the stage file — nesting Bun.build({compile}) on a
  //    pre-bundled file has rough edges (it tries to re-bundle from a single file
  //    with no package.json context); the CLI is explicit, debuggable, and one
  //    extra process per target is negligible at the 4-target scale.
  const compileArgs = [
    'build',
    stagePath,
    '--compile',
    `--target=${bunTarget}`,
    `--outfile=${out}`,
    '--minify',
  ]
  const compileRes = spawnSync(process.execPath, compileArgs, { encoding: 'utf-8' })
  if (compileRes.status !== 0) {
    console.error(compileRes.stderr || compileRes.stdout || '')
    throw new Error(`[build-target] bun compile failed for ${friendly}`)
  }
  if (!existsSync(out)) {
    throw new Error(`[build-target] outfile missing after build: ${out}`)
  }
  // Cross-compiling a Windows target on a POSIX host, Bun writes the correct
  // `--outfile` AND leaks a stray standalone exe named after the ORIGINAL bundle
  // entry (server/src/cli.ts → `cli.exe`) into the project root — not cwd, so it
  // can't be redirected, only cleaned. Remove it (and any stray `.exe` in the
  // gitignored stage dir) so `pnpm release` never litters the repo with a ~100 MB
  // untracked binary. Guard on the real out so we never touch the artifact itself.
  const strayExe = resolve(repoRoot, `${basename(entry).replace(/\.[^.]+$/, '')}.exe`)
  for (const stray of [strayExe, ...readdirSync(stageDir).map((n) => resolve(stageDir, n))]) {
    if (stray !== out && stray.toLowerCase().endsWith('.exe') && existsSync(stray))
      rmSync(stray, { force: true })
  }
  chmodSync(out, 0o755)
  adHocCodesign(out, friendly) // before any hashing — codesign mutates the binary

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
    version: a['version-str'],
    commit: a.commit,
    buildTime: a['build-time'],
  })
}
