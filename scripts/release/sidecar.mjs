// Cursor SDK sidecar — the per-target `@cursor/sdk` tree that ships NEXT TO the
// standalone binary, so a binary deployment can run Cursor at all.
//
// The binary itself carries no Cursor runtime: `@cursor/sdk` resolves a
// per-platform package at load time, so bundling it would freeze the BUILD host's
// platform into every cross-compiled target. The sidecar is how the runtime
// reaches a binary deployment without entering the binary: a real dependency tree
// for ONE target, laid out at `<binary-dir>/node_modules/`, which is where the
// server's resolver looks by default.
//
// 两件事必须按 target 而非按构建宿主决定:平台包(`@cursor/sdk-<os>-<arch>`)由
// `npm --os/--cpu` 选出,校验则断言树里**只有**该目标的平台包。宿主的 optional
// dependency 结果一旦串进交叉编译制品,就会产出一个声称支持 Cursor 却装着错误架构
// 二进制的归档。
//
// ── Root-entry shims ────────────────────────────────────────────────────────
// A Bun standalone binary resolves bare specifiers against a real-filesystem
// `node_modules` — but its resolver does NOT read `package.json`: `main` and
// `exports` are ignored, and only `<pkg>/index.{js,cjs}` is found. A plain npm
// tree is therefore unresolvable from a binary, because nearly every package's
// entry lives in a subdirectory (`dist/cjs/index.js`, `src/index.js`, …).
//
// So staging generates one root `index.cjs` per package, re-exporting that
// package's real entry through a RELATIVE path (relative paths resolve normally).
// The shim is additive: Node still reads `package.json` and never sees it, so an
// npm install's resolution semantics are untouched — the file only matters inside
// the binary. Resolution stays consistent for every package (each has exactly one
// shim pointing at one build), so no package is loaded twice.
//
// Pure Node. CLI: node scripts/release/sidecar.mjs --target=macos-arm64 --dest=dist/macos-arm64
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** The package the server imports — the sidecar exists to make this resolvable. */
export const SDK_PACKAGE = '@cursor/sdk'

/** Sidecar root, relative to the binary. Fixed: the server's default lookup. */
export const SIDECAR_DIRNAME = 'node_modules'

/**
 * Friendly release target → the npm platform selectors and the platform package
 * that target's tree must contain. Keep in sync with `TARGETS` in
 * `server/scripts/release/build-target.mjs`.
 */
export const TARGET_PLATFORMS = {
  'macos-arm64': { os: 'darwin', cpu: 'arm64' },
  'linux-x64': { os: 'linux', cpu: 'x64' },
  'windows-x64': { os: 'win32', cpu: 'x64' },
}

/** The `@cursor/sdk-<os>-<arch>` package a target's sidecar must carry, exactly one. */
export function platformPackageFor(target) {
  const platform = TARGET_PLATFORMS[target]
  if (!platform) throw new Error(`[sidecar] unknown target: ${target}`)
  return `${SDK_PACKAGE}-${platform.os}-${platform.cpu}`
}

/**
 * The SDK version the server depends on. Pinned exactly (no range) so the sidecar
 * and an npm install of c3 can never run different SDKs — a range here would let
 * the release install whatever the registry happens to serve that day.
 */
export function pinnedSdkVersion(serverPkgPath = join(repoRoot, 'server', 'package.json')) {
  const meta = JSON.parse(readFileSync(serverPkgPath, 'utf-8'))
  const spec = meta.dependencies?.[SDK_PACKAGE]
  if (typeof spec !== 'string') {
    throw new Error(`[sidecar] ${SDK_PACKAGE} is not a dependency of server/package.json`)
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec)) {
    throw new Error(
      `[sidecar] ${SDK_PACKAGE} must be pinned to an exact version in server/package.json, got "${spec}"`,
    )
  }
  return spec
}

/** Every package directory in a `node_modules` root, scoped ones included. */
export function listPackages(root) {
  const out = []
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(join(root, entry))) {
        if (!scoped.startsWith('.')) out.push(`${entry}/${scoped}`)
      }
      continue
    }
    out.push(entry)
  }
  return out
}

/**
 * Write the root-entry shims a Bun standalone binary needs (see the header).
 *
 * A package whose real entry already sits at `index.js` / `index.cjs` needs
 * nothing; a package with no module entry at all (the platform package is just a
 * `bin/` directory) is left alone rather than treated as broken.
 *
 * @returns {{ shimmed: string[], native: string[], binOnly: string[] }}
 */
export function generateEntryShims(root) {
  const nodeModules = realpathSync(root)
  const require = createRequire(pathToFileURL(join(nodeModules, '__sidecar__.cjs')))
  const shimmed = []
  const native = []
  const binOnly = []
  for (const name of listPackages(nodeModules)) {
    const dir = realpathSync(join(nodeModules, name))
    if (!existsSync(join(dir, 'package.json'))) continue
    let entry
    try {
      entry = realpathSync(require.resolve(name))
    } catch {
      // No module entry (a `bin/`-only platform package). Nothing to re-export,
      // and nothing imports it by name — the SDK reaches its binaries by path.
      binOnly.push(name)
      continue
    }
    let rel = relative(dir, entry).split('\\').join('/')
    if (!rel.startsWith('.')) rel = `./${rel}`
    if (rel === './index.js' || rel === './index.cjs') {
      native.push(name)
      continue
    }
    // `.cjs` is CommonJS whatever the package's `type` is, so one shim shape
    // serves both module kinds — and Bun prefers `index.cjs`, so a package that
    // already has an unrelated root `index.js` is not shadowed by it.
    writeFileSync(join(dir, 'index.cjs'), `module.exports = require('${rel}')\n`)
    shimmed.push(name)
  }
  return { shimmed, native, binOnly }
}

/**
 * Assert a staged tree is a complete, target-correct sidecar. Throws on the first
 * gap: a half-built sidecar that still packs is worse than a failed build, because
 * the archive would claim Cursor support it cannot deliver.
 */
export function verifySidecar({ root, target, version }) {
  if (!existsSync(root)) throw new Error(`[sidecar] tree missing: ${root}`)
  const sdkDir = join(root, SDK_PACKAGE)
  if (!existsSync(join(sdkDir, 'package.json'))) {
    throw new Error(`[sidecar] ${SDK_PACKAGE} missing from ${root}`)
  }
  const sdkMeta = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf-8'))
  if (sdkMeta.version !== version) {
    throw new Error(
      `[sidecar] ${SDK_PACKAGE} version mismatch: tree has ${sdkMeta.version}, server pins ${version}`,
    )
  }

  const expected = platformPackageFor(target)
  const platformPkgs = listPackages(root).filter(
    (name) => name.startsWith(`${SDK_PACKAGE}-`) && name !== SDK_PACKAGE,
  )
  if (!platformPkgs.includes(expected)) {
    throw new Error(
      `[sidecar] ${target}: platform package ${expected} missing (tree has: ${platformPkgs.join(', ') || 'none'})`,
    )
  }
  const foreign = platformPkgs.filter((name) => name !== expected)
  if (foreign.length) {
    throw new Error(
      `[sidecar] ${target}: foreign platform package(s) in tree: ${foreign.join(', ')}`,
    )
  }
  const binDir = join(root, expected, 'bin')
  if (!existsSync(binDir) || readdirSync(binDir).length === 0) {
    throw new Error(`[sidecar] ${target}: ${expected} carries no bin/ payload`)
  }

  // Every package must be resolvable the way the binary resolves — by root entry.
  // Checking it here is what keeps a missing shim from surfacing as a runtime
  // "Cannot find module" inside a released artifact.
  const unreachable = []
  for (const name of listPackages(root)) {
    const dir = join(root, name)
    if (!existsSync(join(dir, 'package.json'))) continue
    if (name === expected) continue
    if (!existsSync(join(dir, 'index.cjs')) && !existsSync(join(dir, 'index.js'))) {
      unreachable.push(name)
    }
  }
  if (unreachable.length) {
    throw new Error(`[sidecar] ${target}: no root entry for ${unreachable.join(', ')}`)
  }
  return { version, platformPackage: expected, packages: listPackages(root).length }
}

/**
 * Where the throwaway npm staging prefix is created: NEXT TO the destination, not
 * in the OS temp dir.
 *
 * 临时目录与产物目录可能不在同一个卷上 —— Windows runner 的 `TEMP` 在 `C:`,而
 * workspace 在 `D:`,此时把 staging 的 `node_modules` rename 进 `dist/` 会直接
 * `EXDEV: cross-device link not permitted`。把 staging 建在目标的同级目录,rename
 * 就永远是同卷操作。名字以 `.` 开头,不会被任何产物 glob 匹配到。
 */
export function stageParentDir(destDir) {
  return dirname(resolve(destDir))
}

/**
 * Move a directory into place, falling back to copy+delete when the rename crosses
 * a filesystem boundary. `stageParentDir` already keeps staging on the destination's
 * volume, so this only matters for a caller that stages elsewhere.
 */
export function moveTree(src, dest) {
  try {
    renameSync(src, dest)
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err
    cpSync(src, dest, { recursive: true })
    rmSync(src, { recursive: true, force: true })
  }
}

/** Recursive byte size of a directory — for the build log's size accounting. */
function treeBytes(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    total += entry.isDirectory() ? treeBytes(path) : statSync(path).size
  }
  return total
}

/**
 * Install this target's `@cursor/sdk` tree into `<destDir>/node_modules`, shim it,
 * and verify it.
 *
 * npm installs into a throwaway staging prefix and only the finished
 * `node_modules` moves into place, so the artifact directory never collects npm's
 * own `package.json` / lockfile, and a failed install leaves no partial tree
 * behind for `pack` to archive. The prefix sits next to `destDir` (see
 * `stageParentDir`), never in the OS temp dir, so the move stays same-volume.
 *
 * @param {object} o
 * @param {string} o.target    friendly target name
 * @param {string} o.destDir   the directory holding the binary (`dist/<target>`)
 * @param {string} [o.version] SDK version (defaults to the server's pinned one)
 * @param {(m: string) => void} [o.log]
 */
export function stageSidecar({ target, destDir, version, log = () => {} }) {
  const sdkVersion = version ?? pinnedSdkVersion()
  const platform = TARGET_PLATFORMS[target]
  if (!platform) throw new Error(`[sidecar] unknown target: ${target}`)
  if (!existsSync(destDir)) throw new Error(`[sidecar] dest missing: ${destDir}`)

  const stage = mkdtempSync(join(stageParentDir(destDir), `.c3-sidecar-${target}-`))
  const root = join(destDir, SIDECAR_DIRNAME)
  try {
    const res = spawnSync(
      'npm',
      [
        'install',
        '--prefix',
        stage,
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--omit=dev',
        `--os=${platform.os}`,
        `--cpu=${platform.cpu}`,
        `${SDK_PACKAGE}@${sdkVersion}`,
      ],
      { encoding: 'utf-8', shell: process.platform === 'win32' },
    )
    if (res.status !== 0) {
      throw new Error(
        `[sidecar] ${target}: npm install failed (${res.status}): ${(res.stderr || res.stdout || '').trim()}`,
      )
    }
    const staged = join(stage, 'node_modules')
    if (!existsSync(staged)) throw new Error(`[sidecar] ${target}: npm produced no node_modules`)

    // npm's own bookkeeping and its `.bin` shims are host artifacts, not runtime
    // inputs: the SDK reaches its platform binaries by path inside the platform
    // package, so dropping them keeps the archive deterministic (and free of
    // symlinks a Windows zip cannot carry).
    rmSync(join(staged, '.package-lock.json'), { force: true })
    rmSync(join(staged, '.bin'), { recursive: true, force: true })

    const shims = generateEntryShims(staged)
    rmSync(root, { recursive: true, force: true })
    moveTree(staged, root)

    const summary = verifySidecar({ root, target, version: sdkVersion })
    const bytes = treeBytes(root)
    log(
      `  sidecar ${target}  ${SDK_PACKAGE}@${sdkVersion} + ${summary.platformPackage}  ` +
        `(${summary.packages} pkgs, ${shims.shimmed.length} shimmed, ${(bytes / 1024 / 1024).toFixed(1)} MiB)`,
    )
    return { target, root, bytes, shims, ...summary }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
      return m ? [m[1], m[2] ?? true] : [a, true]
    }),
  )
  if (!args.target || !args.dest) {
    console.error('usage: sidecar.mjs --target=<target> --dest=<dir> [--version=<ver>]')
    process.exit(2)
  }
  const result = stageSidecar({
    target: String(args.target),
    destDir: resolve(String(args.dest)),
    version: args.version ? String(args.version) : undefined,
    log: (m) => console.log(m),
  })
  console.log(`[sidecar] OK ${result.target} → ${result.root}`)
}
