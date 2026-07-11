// Package a built `dist/<target>/c3` (+ inner sidecars) into a distributable
// archive: `dist/c3-v{ver}-{target}.tar.gz` (POSIX) or `.zip` (Windows).
//
// The binary is ALWAYS named `c3` (or `c3.exe` on Windows) — never the version
// or the platform. The version + platform info lives ONLY in the package
// filename, exactly as the consumer-facing design requires. Inside the
// archive, the top-level files are `c3`, `c3.sha256` (flat, no
// subdirectory) so `tar -xzf … && ./c3 --version` works out of the box.
//
// 开源版已移除 minisign 签名:只生成 `c3.sha256` 完整性校验和(不再生成 `c3.minisig`)。
// 该 sidecar 在此步生成,因为二进制字节此时已最终确定(codesign 已在 `buildTarget`
// 内运行)。sidecar 以稳定的包内名 `c3` 引用二进制,解包后即可用
// `shasum -a 256 -c c3.sha256` 校验。
//
// Cross-platform: the archive tool is the shell `tar` (POSIX targets) or `zip`.
// The Windows `.zip` is host-branched so it works BOTH on a native Windows runner
// (PowerShell `Compress-Archive`) and when cross-building on macOS/Linux (the POSIX
// `zip` CLI) — since Bun cross-compiles `c3.exe` from one host, `pnpm release` packs
// all three targets on a single machine. We intentionally don't pull a tar/zip
// dependency for the few KB this saves.
//
// Pure Node. CLI: node scripts/release/pack.mjs --target=macos-arm64 --version=0.2.0 [--dist=dist]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { binaryName, packageName, packageExt } from './artifact-name.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** Generate the in-package sidecar (`c3.sha256`) next to `c3`. */
function writeInnerSidecars(binaryPath, distDir, log = () => {}) {
  const bytes = readFileSync(binaryPath)
  const hex = createHash('sha256').update(bytes).digest('hex')
  // The inner sidecar names the binary as `c3` (its in-package name), not the
  // dist-relative path — this is what `shasum -a 256 -c c3.sha256` will look
  // for after the consumer untars into a clean directory.
  const shaLine = `${hex}  c3\n`
  writeFileSync(join(distDir, 'c3.sha256'), shaLine)
  log(`  sha256  c3  ${hex}`)
  return hex
}

/** POSIX `tar -czf <out> -C <srcDir> .` — portable, no deps. Files land at
 * the tarball root, no enclosing subdir, so `tar -xzf … && ./c3 --version`
 * works out of the box. The per-target subdir on disk is internal scratch
 * (so parallel builds don't clobber each other) and must NOT bleed into
 * the consumer's untar layout. */
function tarGz(srcDir, outFile) {
  const res = spawnSync('tar', ['-czf', outFile, '-C', srcDir, '.'], { encoding: 'utf-8' })
  if (res.status !== 0)
    throw new Error(`[pack] tar -czf failed (${res.status}): ${(res.stderr || '').trim()}`)
}

/** Zip the directory CONTENTS at the archive root (no enclosing folder), so
 *  `unzip … && ./c3.exe --version` works out of the box. Host-branched so a
 *  Windows `.zip` can be produced BOTH on a native Windows runner (PowerShell
 *  `Compress-Archive`) and when cross-building on macOS/Linux (the POSIX `zip`
 *  CLI, which Bun makes possible by cross-compiling `c3.exe` from one host). */
function zipDir(srcDir, outFile) {
  if (process.platform === 'win32') {
    // Compress-Archive takes a source path + destination; `\*` packs the contents.
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${outFile}' -Force`,
      ],
      { encoding: 'utf-8', shell: true },
    )
    if (res.status !== 0)
      throw new Error(
        `[pack] Compress-Archive failed (${res.status}): ${(res.stderr || '').trim()}`,
      )
    return
  }
  // POSIX `zip`: append-mode by default, so drop any stale archive first, then
  // `-r .` from inside srcDir to keep files at the zip root (no enclosing dir).
  if (existsSync(outFile)) rmSync(outFile)
  const res = spawnSync('zip', ['-r', '-X', '-q', outFile, '.'], { cwd: srcDir, encoding: 'utf-8' })
  if (res.status !== 0)
    throw new Error(
      `[pack] zip failed (${res.status}): ${(res.stderr || '').trim() || 'is the `zip` CLI installed?'}`,
    )
}

/**
 * Package one target. Side-effects:
 *   - writes `dist/<target>/c3.sha256` (inner sidecar)
 *   - writes `dist/c3-v{ver}-{target}{.tar.gz|.zip}` (the distributable package)
 * @param {object} o
 * @param {string} o.target
 * @param {string} o.version
 * @param {string} [o.distDir]   defaults to `<repoRoot>/dist`
 * @param {(m: string) => void} [o.log]
 * @returns {{
 *   target: string,
 *   package: string,          // filename of the tarball/zip
 *   binary: string,           // in-package binary name (`c3` / `c3.exe`)
 *   bytes: number,            // size of the package file
 *   sha256: string,           // sha256 of the PACKAGE (matches SHA256SUMS line)
 *   innerSha256: string,      // sha256 of the in-package binary (for the manifest)
 * }}
 */
export function packOne({ target, version, distDir: distDirOpt, log = () => {} } = {}) {
  if (!target) throw new Error('[pack] target is required')
  if (!version) throw new Error('[pack] version is required')
  const distDir = distDirOpt ? resolve(distDirOpt) : resolve(repoRoot, 'dist')
  const name = binaryName(target)
  const binaryPath = join(distDir, target, name)
  if (!existsSync(binaryPath)) throw new Error(`[pack] binary missing for ${target}: ${binaryPath}`)

  const innerSha = writeInnerSidecars(binaryPath, join(distDir, target), log)

  const pkg = packageName(version, target)
  const pkgPath = join(distDir, pkg)
  const srcDir = join(distDir, target)

  if (target.startsWith('windows')) {
    zipDir(srcDir, pkgPath)
  } else {
    tarGz(srcDir, pkgPath)
  }

  const bytes = statSync(pkgPath).size
  const pkgSha = createHash('sha256').update(readFileSync(pkgPath)).digest('hex')
  log(`  pack    ${pkg}  (${(bytes / 1024 / 1024).toFixed(1)} MiB, sha256=${pkgSha.slice(0, 12)}…)`)
  return {
    target,
    package: pkg,
    binary: name,
    bytes,
    sha256: pkgSha,
    innerSha256: innerSha,
  }
}

/**
 * Package every built target under `dist/`. A target is "built" if
 * `dist/<target>/c3` (or `c3.exe`) exists.
 * @param {object} o
 * @param {string[]} o.targets
 * @param {string} o.version
 * @param {string} [o.distDir]
 * @param {(m: string) => void} [o.log]
 * @returns {Array<{ target, package, binary, bytes, sha256 }>}
 */
export function packAll({ targets, version, distDir: distDirOpt, log = () => {} } = {}) {
  const distDir = distDirOpt ? resolve(distDirOpt) : resolve(repoRoot, 'dist')
  const out = []
  for (const t of targets) {
    const binary = join(distDir, t, binaryName(t))
    if (!existsSync(binary)) {
      log(`  ⤳ ${t}: skip pack (no binary at ${binary})`)
      continue
    }
    out.push(packOne({ target: t, version, distDir, log }))
  }
  return out
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
  if (!args.target || !args.version) {
    console.error('usage: pack.mjs --target=<target> --version=<ver> [--dist=dist]')
    process.exit(2)
  }
  const distDir = args.dist ? resolve(String(args.dist)) : resolve(repoRoot, 'dist')
  const res = packOne({
    target: String(args.target),
    version: String(args.version),
    distDir,
    log: (m) => console.log(m),
  })
  console.log(`[pack] OK ${res.target} → ${res.package} (${res.bytes}B)`)
}

// Re-export for the orchestrator.
export { packageName, packageExt, binaryName }
