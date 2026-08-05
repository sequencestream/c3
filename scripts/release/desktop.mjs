// release:desktop —— 桌面渠道的构建编排(只构建,不发布)。
//
// 顺序与 CLI 渠道刻意保持同构,并且**复用同一批原语**:
//
//   Phase0   web build              一次,平台无关          (pnpm -F @ccc/web build)
//   Phase1   generate-static-embed  一次,写 dist/static-embed.generated.ts
//   Phase2   compile sidecar        server/scripts/release/build-target.mjs
//                                   —— 唯一的 `bun --compile` 原语。桌面版不另起
//                                   一套服务端编译,sidecar 与 CLI 版是同一份产物。
//   Phase3   stage + verify         按 Tauri 三元组约定改名放进 src-tauri/binaries/,
//                                   并校验 `c3 --version` 与本次发布版本逐字相同 ——
//                                   壳与 sidecar 版本不一致的包一律不许出厂。
//   Phase4   tauri build            原生 runner 上打包/签名;Tauri 不做跨平台打包。
//   Phase5   collect                bundle → dist/c3-desktop-v{ver}-{target}{ext},
//                                   计算 sha256,合并进 dist/manifest.json。
//
// 桌面产物与 CLI 产物进同一个版本、同一个 manifest、同一条校验链,但产物名与
// `channel` 字段不同,消费者可以明确地二选一。
//
// Usage:
//   node scripts/release/desktop.mjs [--targets=macos-arm64] [--skip-web]
//                                    [--require-signing] [--dry-run]
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeVersionInfo } from './version-info.mjs'
import {
  buildManifest,
  carryForwardArtifacts,
  writeManifest,
  CHANNEL_DESKTOP,
  sha256File,
} from './manifest.mjs'
import { binaryName, normalizeVersion } from './artifact-name.mjs'
import {
  DESKTOP_TARGETS,
  bundleVersion,
  desktopBundles,
  desktopPackageName,
  isDesktopHostTarget,
  rustTriple,
  sidecarStageName,
  tauriBundleFlags,
} from './desktop-artifacts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const desktopDir = resolve(repoRoot, 'desktop')
const srcTauriDir = resolve(desktopDir, 'src-tauri')
const stageDir = resolve(srcTauriDir, 'binaries')
/** tauri build 的版本覆盖文件。生成物,已 gitignore。 */
const RELEASE_CONFIG = 'tauri.release.json'

function parseArgs(argv) {
  const o = {}
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) o[m[1]] = m[2]
    else if (a.startsWith('--')) o[a.slice(2)] = true
  }
  return o
}

/** 与 release-build.mjs 同款:Windows 上必须过 shell 才能解析 `pnpm.CMD`。 */
function run(cmd, args, label, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: opts.cwd ?? repoRoot,
      shell: process.platform === 'win32',
      env: { ...process.env, ...(opts.env ?? {}) },
    })
    p.on('error', rej)
    p.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`[release:desktop] ${label} → exit ${code}`)),
    )
  })
}

function findBun() {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
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
  throw new Error('[release:desktop] bun not found. Install from https://bun.sh, or set BUN_BIN.')
}

/**
 * 把编译好的 sidecar 放到 Tauri 约定的位置与文件名。
 *
 * 名字错一个字符,`tauri build` 会以 "resource path doesn't exist" 失败 —— 这里显式
 * 断言源文件存在,好让错误停在原地而不是三步之后。
 */
export function stageSidecarBinary({ target, binaryPath, destDir = stageDir, log = () => {} }) {
  if (!existsSync(binaryPath)) {
    throw new Error(`[release:desktop] sidecar binary missing for ${target}: ${binaryPath}`)
  }
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, sidecarStageName(target))
  copyFileSync(binaryPath, dest)
  log(`  staged  ${basename(binaryPath)} → binaries/${basename(dest)}`)
  return dest
}

/**
 * 构建期版本门禁:sidecar 自报的版本必须与本次发布版本逐字相同。
 *
 * 只有宿主可执行的目标才能真的跑起来问它;交叉目标跳过并交给它自己那台 runner ——
 * 三平台矩阵里每个目标都在原生 runner 上构建,所以实际不会有目标漏检。
 */
export function verifySidecarVersion({ target, binaryPath, expected, log = () => {} }) {
  if (!isDesktopHostTarget(target)) {
    log(`  ⤳ ${target}: skip sidecar version check (not runnable on this host)`)
    return { checked: false }
  }
  const res = spawnSync(binaryPath, ['--version'], { encoding: 'utf-8' })
  if (res.status !== 0) {
    throw new Error(
      `[release:desktop] ${target}: sidecar \`--version\` exited ${res.status}: ${(res.stderr || '').trim()}`,
    )
  }
  // 两侧都过 normalizeVersion:版本 SoT 是 git tag,`git describe` 会带上 tag 自己的
  // `v` 前缀,而各处对这个前缀的处理并不统一。比较必须在同一个归一化形态上做,
  // 否则这道门禁会把一个完全正确的构建判为版本不符。
  const actual = normalizeVersion((res.stdout || '').trim().split(/\s+/)[0] ?? '')
  const want = normalizeVersion(expected)
  if (actual !== want) {
    throw new Error(
      `[release:desktop] ${target}: sidecar version '${actual}' ≠ release version '${want}' — ` +
        `a desktop package must never ship a sidecar from another build`,
    )
  }
  log(`  ✓ sidecar version ${actual} matches the release version`)
  return { checked: true, version: actual }
}

/** 在 bundle 目录里按扩展名发现 Tauri 产出的文件(它的命名各平台不同,不预测)。 */
export function findBundleArtifact(bundleRoot, bundle) {
  const dir = join(bundleRoot, bundle.dir)
  if (!existsSync(dir)) return null
  const hits = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(bundle.ext.toLowerCase()))
  if (!hits.length) return null
  // 同一目录里出现多个候选(重复构建的残留)时取最新的那个。
  const sorted = hits
    .map((n) => join(dir, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return sorted[0]
}

/** `tar -czf` 一个目录型产物(macOS `.app`),保留符号链接与权限位。 */
function tarGzDir(srcPath, outFile) {
  const res = spawnSync('tar', ['-czf', outFile, '-C', dirname(srcPath), basename(srcPath)], {
    encoding: 'utf-8',
  })
  if (res.status !== 0) {
    throw new Error(
      `[release:desktop] tar -czf failed (${res.status}): ${(res.stderr || '').trim()}`,
    )
  }
}

/**
 * macOS 正式产物的签名/公证门禁。
 *
 * `--require-signing` 打开时,未签名或未 staple 的包一律阻断 —— spec 明确要求
 * 不得以未签名 macOS 包替代正式产物。关闭时(本地构建)只打印现状。
 */
export function verifyMacSigning({ appPath, dmgPath, require: required, log = () => {} }) {
  if (process.platform !== 'darwin') return { verified: false, reason: 'not a macOS host' }
  const checks = []
  const codesign = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    encoding: 'utf-8',
  })
  checks.push({ name: 'codesign --verify', ok: codesign.status === 0, out: codesign.stderr })
  const stapled = spawnSync('stapler', ['validate', dmgPath ?? appPath], { encoding: 'utf-8' })
  checks.push({ name: 'stapler validate', ok: stapled.status === 0, out: stapled.stdout })

  for (const c of checks) log(`  ${c.ok ? '✓' : '✗'} ${c.name}`)
  const failed = checks.filter((c) => !c.ok)
  if (failed.length && required) {
    throw new Error(
      `[release:desktop] macOS release gate failed: ${failed.map((f) => f.name).join(', ')}. ` +
        `Signing/notarization credentials must be present for a release build ` +
        `(APPLE_CERTIFICATE, APPLE_SIGNING_IDENTITY, APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID).`,
    )
  }
  if (failed.length) {
    log('  ⚠️ unsigned / un-notarized build — fine locally, NOT publishable')
  }
  return { verified: failed.length === 0 }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const requested = args.targets
    ? String(args.targets)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : // Tauri 不做跨平台打包,所以默认只构建宿主目标。
      DESKTOP_TARGETS.filter((t) => isDesktopHostTarget(t))

  if (!requested.length) {
    throw new Error(
      `[release:desktop] no desktop target for this host (${process.platform}-${process.arch}). ` +
        `Desktop packages are built on native runners only.`,
    )
  }
  const unknown = requested.filter((t) => !DESKTOP_TARGETS.includes(t))
  if (unknown.length) {
    throw new Error(
      `[release:desktop] unknown target(s): ${unknown.join(', ')} — known: ${DESKTOP_TARGETS.join(', ')}`,
    )
  }
  const foreign = requested.filter((t) => !isDesktopHostTarget(t))
  if (foreign.length) {
    throw new Error(
      `[release:desktop] cannot build ${foreign.join(', ')} on ${process.platform}-${process.arch}: ` +
        `Tauri has no cross-platform bundling. Run this on that target's native runner.`,
    )
  }

  const versionInfo = computeVersionInfo()
  const bundleVer = bundleVersion(versionInfo.version)
  const distDir = resolve(repoRoot, 'dist')
  const manifestPath = join(distDir, 'manifest.json')
  const requireSigning = Boolean(args['require-signing'])

  console.log('[release:desktop] plan:')
  console.log(
    `  version   ${versionInfo.version} (bundle ${bundleVer}, commit ${versionInfo.commit})`,
  )
  console.log(`  targets   ${requested.join(', ')}`)
  console.log(`  signing   ${requireSigning ? 'REQUIRED (release)' : 'best-effort (local)'}`)
  console.log(`  manifest  ${manifestPath} (channel=${CHANNEL_DESKTOP})`)
  if (args['dry-run']) {
    console.log('[release:desktop] --dry-run: nothing executed.')
    return
  }

  // ── Phase0/1 —— 与 CLI 渠道完全相同的 web 快照生成 ─────────────────────────
  if (!args['skip-web']) {
    console.log('\n[release:desktop] Phase0 — web build')
    await run('pnpm', ['-F', '@ccc/web', 'build'], 'web build')
  }
  console.log('\n[release:desktop] Phase1 — generate-static-embed')
  await run(
    'node',
    [resolve(repoRoot, 'server', 'scripts', 'generate-static-embed.mjs')],
    'generate-static-embed',
  )

  const bun = findBun()
  const buildTargetScript = resolve(repoRoot, 'server', 'scripts', 'release', 'build-target.mjs')
  const embedPath = join(distDir, 'static-embed.generated.ts')
  const produced = []

  for (const target of requested) {
    console.log(`\n[release:desktop] ── ${target} ─────────────────────────────`)

    // ── Phase2 —— sidecar 复用唯一的编译原语 ────────────────────────────────
    console.log('[release:desktop] Phase2 — compile sidecar (build-target.mjs)')
    const binaryPath = join(distDir, target, binaryName(target))
    await run(
      bun,
      [
        'run',
        buildTargetScript,
        `--target=${target}`,
        `--outfile=${binaryPath}`,
        `--embed=${embedPath}`,
        `--version-str=${versionInfo.version}`,
        `--commit=${versionInfo.commit}`,
        `--build-time=${versionInfo.buildTime}`,
      ],
      `compile ${target}`,
    )

    // ── Phase3 —— 暂存 + 版本门禁 ───────────────────────────────────────────
    console.log('[release:desktop] Phase3 — stage sidecar + version gate')
    stageSidecarBinary({ target, binaryPath, log: (m) => console.log(m) })
    verifySidecarVersion({
      target,
      binaryPath,
      expected: versionInfo.version,
      log: (m) => console.log(m),
    })

    // ── Phase4 —— tauri build ───────────────────────────────────────────────
    console.log('[release:desktop] Phase4 — tauri build')
    // 版本覆盖写成文件而不是内联 JSON:内联 JSON 在 PowerShell 下的引号转义是
    // 跨平台脚本里最容易出错的一环。
    const releaseConfigPath = join(srcTauriDir, RELEASE_CONFIG)
    writeFileSync(releaseConfigPath, `${JSON.stringify({ version: bundleVer }, null, 2)}\n`)
    const triple = rustTriple(target)
    try {
      await run(
        'pnpm',
        [
          '-F',
          '@ccc/desktop',
          'exec',
          'tauri',
          'build',
          '--target',
          triple,
          '--bundles',
          tauriBundleFlags(target).join(','),
          // 绝对路径:`--config` 的相对路径基准在 CLI 版本之间摇摆过,绝对路径没有歧义。
          '--config',
          releaseConfigPath,
        ],
        `tauri build ${target}`,
        {
          env: {
            // 壳把这个值编译进去,运行时用它拒绝版本不一致的 sidecar。
            C3_SIDECAR_VERSION: normalizeVersion(versionInfo.version),
          },
        },
      )
    } finally {
      rmSync(releaseConfigPath, { force: true })
    }

    // ── Phase5 —— 收集 + 校验和 ─────────────────────────────────────────────
    console.log('[release:desktop] Phase5 — collect bundles')
    const bundleRoot = join(srcTauriDir, 'target', triple, 'release', 'bundle')
    mkdirSync(distDir, { recursive: true })
    let appPath = null
    let dmgPath = null

    for (const bundle of desktopBundles(target)) {
      const found = findBundleArtifact(bundleRoot, bundle)
      if (!found) {
        throw new Error(
          `[release:desktop] ${target}: no ${bundle.kind} artifact under ${join(bundleRoot, bundle.dir)} — ` +
            `the bundling step produced nothing for this format`,
        )
      }
      const outName = desktopPackageName(versionInfo.version, target, bundle)
      const outPath = join(distDir, outName)
      rmSync(outPath, { force: true })
      if (bundle.archive === 'tar.gz') {
        tarGzDir(found, outPath)
      } else {
        copyFileSync(found, outPath)
      }
      if (bundle.kind === 'app') appPath = found
      if (bundle.kind === 'dmg') dmgPath = found
      const sha256 = sha256File(outPath)
      const bytes = statSync(outPath).size
      produced.push({
        target,
        file: outPath,
        kind: bundle.kind,
        channel: CHANNEL_DESKTOP,
        bytes,
        sha256,
      })
      console.log(
        `  bundle  ${outName}  (${(bytes / 1024 / 1024).toFixed(1)} MiB, sha256=${sha256.slice(0, 12)}…)`,
      )
    }

    if (target.startsWith('macos') && appPath) {
      console.log('[release:desktop] macOS signing / notarization gate')
      verifyMacSigning({
        appPath,
        dmgPath,
        require: requireSigning,
        log: (m) => console.log(m),
      })
    }
  }

  // ── manifest —— 桌面条目与既有 CLI 条目并存于同一份文件 ────────────────────
  const carried = carryForwardArtifacts(
    manifestPath,
    versionInfo,
    produced.map((p) => p.file),
  )
  const manifest = buildManifest({ versionInfo, artifacts: produced })
  manifest.artifacts = [...carried, ...manifest.artifacts]
  writeManifest(manifestPath, manifest)
  console.log(`\n[release:desktop] manifest → ${manifestPath}`)
  for (const a of manifest.artifacts) {
    console.log(`  ${a.channel}  ${a.target}  ${a.kind ?? '-'}  ${a.file}  (${a.bytes}B)`)
  }
  console.log('\n[release:desktop] OK')
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  main().catch((err) => {
    console.error(`[release:desktop] ✗ ${err.message}`)
    process.exit(1)
  })
}
