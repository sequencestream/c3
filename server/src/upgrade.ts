/**
 * `c3 upgrade` — self-update the installed single binary from GitHub Releases.
 *
 * The orchestration + binary-replace logic for the CLI distribution. All version
 * facts, release resolution, download and checksum verification live in the shared
 * kernel (`upgrade-core.ts`); this file adds the CLI's output, exit-code contract,
 * runtime-form gate and the same-directory atomic replace.
 *
 * Its two mechanical halves — `stageRelease` (download → verify → unpack, touching
 * nothing installed) and `applyStaged` (the one mutating swap) — are also what the
 * console's self-update drives, so both entry points share one set of integrity
 * rules and one replace strategy per platform.
 *
 * Flow: resolve runtime form → resolve the latest release tag (GitHub Releases
 * redirect first, JSON API only as fallback) → pick this platform's
 * package → download package + `.sha256` → cross-check the PACKAGE bytes against
 * the published sha256 checksum → unpack the inner `c3`/`c3.exe` → replace the
 * current binary with a same-directory temp file + atomic rename (POSIX) or a
 * `.exe.old` placeholder swap (Windows, where a running exe cannot be overwritten
 * in place). Any failure before the final rename leaves the original binary intact.
 *
 * Hard rules (see doc/non-functional/release.md):
 *   - the download is cross-checked against its published sha256 checksum when present.
 *   - only the current, locatable, writable binary (`process.execPath`) is touched.
 *   - PATH / shell profiles / package-manager locations are never modified.
 *   - upgrade NEVER restarts anything — it prints precise next-step guidance and
 *     leaves "make the new version take effect" to `c3 restart` (or a manual rerun).
 *   - dev / source / interpreter runs refuse to self-update (no single binary to swap).
 *
 * All side effects are injectable ({@link UpgradeIo}, {@link UpgradeDeps}) so the
 * orchestrator and the replace strategies are unit-testable without network or a
 * real binary.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { c3HomeDir } from './kernel/config/index.js'
import { outboundFetch } from './kernel/infra/proxy-fetch.js'
import { isInterpreter } from './daemon.js'
import { detectRuntimeForms, type RuntimeForms } from './restart.js'
import { VERSION } from './version.js'
import {
  DEFAULT_REPO,
  UPGRADE_EXIT,
  UpgradeError,
  decideAction,
  downloadBuffer,
  downloadStreamed,
  normalizeVersion,
  parseSha256Line,
  resolveLatestRelease,
  sha256Hex,
  verifySha256,
  type ReleaseAsset,
} from './upgrade-core.js'

export { DEFAULT_REPO, UPGRADE_EXIT, UpgradeError } from './upgrade-core.js'
export {
  compareVersions,
  decideAction,
  normalizeVersion,
  parseTagFromLocation,
  resolveTagViaRedirect,
  type ReleaseAsset,
  type ResolvedRelease,
  type UpgradeAction,
} from './upgrade-core.js'

/** The c3 binary basename inside a release package — always `c3`/`c3.exe`. */
function binaryNameFor(target: string): string {
  return target.startsWith('windows') ? 'c3.exe' : 'c3'
}

// ── Platform mapping + package naming (mirrors scripts/release; cross-tested) ──

/**
 * The friendly target name runnable on this host (`<os>-<arch>`), e.g. `macos-arm64`.
 * `darwin → macos`, `win32 → windows`, matching the release artifact convention.
 * Mirrors `hostTarget` in scripts/release/targets.mjs (cross-asserted by a test so
 * the two cannot drift); whether a matching artifact actually exists is decided
 * later, at asset selection (e.g. `linux-arm64` is a valid name but unpublished).
 */
export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform
  return `${os}-${arch}`
}

/** `.zip` on Windows targets, `.tar.gz` elsewhere (mirrors artifact-name.mjs). */
export function packageExt(target: string): string {
  return target.startsWith('windows') ? '.zip' : '.tar.gz'
}

/** `c3-cli` — the release package filename prefix (mirrors PACKAGE_PREFIX). */
export const PACKAGE_PREFIX = 'c3-cli'

/** `c3-cli-v{ver}-{target}{.ext}` — the release package basename (mirrors packageName). */
export function packageNameFor(version: string, target: string): string {
  return `${PACKAGE_PREFIX}-v${normalizeVersion(version)}-${target}${packageExt(target)}`
}

// ── Runtime-form gate ───────────────────────────────────────────────────────

/**
 * Whether self-update is allowed. Refused for dev/source runs: a `0.0.0-dev`
 * version (no build injection) or an interpreter `execPath` (node/bun/tsx) means
 * there is no single binary to replace — swapping one would break the dev env.
 */
export function isSelfUpdatable(
  execPath: string,
  version: string,
): { ok: boolean; reason?: string } {
  if (version === '0.0.0-dev') {
    return { ok: false, reason: 'running an unbuilt dev version (0.0.0-dev)' }
  }
  if (isInterpreter(execPath)) {
    return { ok: false, reason: `running under an interpreter (${execPath})` }
  }
  return { ok: true }
}

// ── Asset selection ─────────────────────────────────────────────────────────

export interface SelectedAssets {
  pkgName: string
  pkgUrl: string
  sha256Url?: string
}

/**
 * Locate the package asset and its sha256 sidecar in a release's asset list. The
 * package MUST be present (else there is no artifact for this platform → fail
 * without touching local files); a missing `.sha256` is tolerated (the checksum
 * cross-check is skipped).
 */
export function selectAssets(assets: ReleaseAsset[], pkgName: string): SelectedAssets {
  const byName = new Map(assets.map((a) => [a.name, a.url]))
  const pkgUrl = byName.get(pkgName)
  if (!pkgUrl) {
    throw new UpgradeError(
      `no release artifact for this platform: ${pkgName} not found in the latest release`,
      UPGRADE_EXIT.noArtifact,
    )
  }
  return {
    pkgName,
    pkgUrl,
    sha256Url: byName.get(`${pkgName}.sha256`),
  }
}

/**
 * Deterministic download URLs for a package + its sidecars, given a known release
 * tag. Anchored to `packageNameFor` (same naming the release scripts publish), so
 * the primary path needs no asset-list lookup: the package lives at
 * `.../releases/download/<tag>/<pkgName>` and the sidecar is that URL plus
 * `.sha256`. The raw published `tag` (e.g. `v2.0.0`) is used in the path, not the
 * normalized version.
 */
export function buildDownloadUrls(repo: string, tag: string, pkgName: string): SelectedAssets {
  const pkgUrl = `https://github.com/${repo}/releases/download/${tag}/${pkgName}`
  return {
    pkgName,
    pkgUrl,
    sha256Url: `${pkgUrl}.sha256`,
  }
}

// ── Injectable side effects ─────────────────────────────────────────────────

/** Side effects the orchestrator performs, injectable for tests. */
export interface UpgradeIo {
  mkdtemp(prefix: string): string
  writeFile(path: string, data: Buffer): void
  readFile(path: string): Buffer
  exists(path: string): boolean
  chmod(path: string, mode: number): void
  rename(from: string, to: string): void
  remove(path: string): void
  /** Open `path` for chunked writes, so a large package never has to fit in memory. */
  openWrite(path: string): WriteHandle
  /** Extract `archivePath` into `destDir` using the platform archive tool. */
  unpack(archivePath: string, destDir: string, target: string): void
  /** Run `binPath --version`; resolves on success, throws on a non-runnable binary. */
  selfCheckVersion(binPath: string): string
}

/** A chunked writer opened by {@link UpgradeIo.openWrite}. */
export interface WriteHandle {
  write(chunk: Uint8Array): void
  close(): void
}

function defaultOpenWrite(path: string): WriteHandle {
  const fd = openSync(path, 'w')
  let open = true
  return {
    write: (chunk) => writeSync(fd, chunk),
    close: () => {
      if (!open) return
      open = false
      closeSync(fd)
    },
  }
}

function defaultUnpack(archivePath: string, destDir: string, target: string): void {
  const res = target.startsWith('windows')
    ? spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ],
        { encoding: 'utf-8' },
      )
    : spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { encoding: 'utf-8' })
  if (res.error || res.status !== 0) {
    throw new UpgradeError(
      `failed to unpack ${archivePath}: ${(res.stderr || res.error?.message || '').trim()}`,
      UPGRADE_EXIT.unpackFailed,
    )
  }
}

function defaultSelfCheck(binPath: string): string {
  const res = spawnSync(binPath, ['--version'], { encoding: 'utf-8' })
  if (res.error || res.status !== 0) {
    throw new UpgradeError(
      `downloaded binary failed its --version self-check: ${(res.stderr || res.error?.message || '').trim()}`,
      UPGRADE_EXIT.replaceFailed,
    )
  }
  return (res.stdout ?? '').trim()
}

const defaultIo: UpgradeIo = {
  mkdtemp: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  writeFile: (path, data) => writeFileSync(path, data),
  readFile: (path) => readFileSync(path),
  exists: (path) => existsSync(path),
  chmod: (path, mode) => chmodSync(path, mode),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  openWrite: defaultOpenWrite,
  unpack: defaultUnpack,
  selfCheckVersion: defaultSelfCheck,
}

/** The default side effects, for callers that only need to override a few. */
export function defaultUpgradeIo(): UpgradeIo {
  return defaultIo
}

// ── Staging: download → verify → unpack ─────────────────────────────────────

/** A downloaded, checksum-verified, unpacked release sitting in a scratch dir. */
export interface StagedRelease {
  /** The normalized version staged. */
  version: string
  /** The published tag the package came from (e.g. `v2.0.0`). */
  tag: string
  /** The package basename that was downloaded. */
  pkgName: string
  /** Absolute path of the unpacked inner `c3` / `c3.exe`. */
  binPath: string
  /** True when the release published a `.sha256` sidecar and it matched. */
  checksumVerified: boolean
}

export interface StageReleaseParams {
  repo: string
  /** The published tag to download from. */
  tag: string
  /** The normalized version that tag resolves to. */
  version: string
  /** Release target (`macos-arm64`, `windows-x64`, …). */
  target: string
  /** An existing directory the package and its unpacked contents land in. */
  dir: string
  /** Enumerated release assets when the resolver had them; else URLs come from the tag. */
  assets?: ReleaseAsset[]
}

export interface StageReleaseDeps {
  io: UpgradeIo
  fetchFn: typeof fetch
  env: NodeJS.ProcessEnv
  /** Provide to stream the package with progress instead of buffering it whole. */
  onProgress?: (receivedBytes: number, totalBytes: number) => void
  /** Polled between chunks of a streamed download; true stops the transfer. */
  shouldAbort?: () => boolean
}

/**
 * Turn "a release tag" into "a runnable binary on disk", without touching the
 * installed one. Download the package, cross-check it against the published
 * `.sha256` sidecar, unpack it and confirm the inner binary is there.
 *
 * A missing sidecar is tolerated (the transport is already TLS-authenticated to
 * github.com); a present-but-mismatching one is fatal — the caller's install is
 * left untouched.
 *
 * Every failure is an {@link UpgradeError} with a stable code, so both the CLI
 * (exit codes) and the console (failure tokens) map it without string matching.
 */
export async function stageRelease(
  params: StageReleaseParams,
  deps: StageReleaseDeps,
): Promise<StagedRelease> {
  const { repo, tag, version, target, dir, assets } = params
  const { io, fetchFn, env } = deps
  const pkgName = packageNameFor(version, target)
  const selected = assets ? selectAssets(assets, pkgName) : buildDownloadUrls(repo, tag, pkgName)
  const pkgPath = join(dir, selected.pkgName)

  // Hash while the bytes flow rather than re-reading the file afterwards: the
  // digest must cover exactly what was written, not whatever is on disk later.
  let actualSha: string
  if (deps.onProgress || deps.shouldAbort) {
    const handle = io.openWrite(pkgPath)
    try {
      const streamed = await downloadStreamed(selected.pkgUrl, fetchFn, env, {
        write: (chunk) => handle.write(chunk),
        onProgress: deps.onProgress,
        shouldAbort: deps.shouldAbort,
      })
      actualSha = streamed.sha256
    } finally {
      handle.close()
    }
  } else {
    const bytes = await downloadBuffer(selected.pkgUrl, fetchFn, env)
    io.writeFile(pkgPath, bytes)
    actualSha = sha256Hex(bytes)
  }

  const sha256Line = selected.sha256Url
    ? (await downloadBuffer(selected.sha256Url, fetchFn, env)).toString('utf-8')
    : undefined
  let checksumVerified = false
  if (sha256Line && sha256Line.trim() !== '') {
    const expected = parseSha256Line(sha256Line)
    if (!expected || !verifySha256(actualSha, expected)) {
      throw new UpgradeError(
        `sha256 mismatch (have ${actualSha}, expected ${expected ?? 'an unreadable sidecar'})`,
        UPGRADE_EXIT.verifyFailed,
      )
    }
    checksumVerified = true
  }

  // Package contents are flat (`c3`, `c3.sha256`); their names don't collide with
  // the downloaded package-level files (`c3-cli-v…{.tar.gz,.sha256}`).
  io.unpack(pkgPath, dir, target)
  const binPath = join(dir, binaryNameFor(target))
  if (!io.exists(binPath)) {
    throw new UpgradeError(
      `unpacked archive is missing the expected binary ${binaryNameFor(target)}`,
      UPGRADE_EXIT.unpackFailed,
    )
  }

  return { version, tag, pkgName: selected.pkgName, binPath, checksumVerified }
}

// ── Binary replacement strategies ───────────────────────────────────────────

/**
 * Swap `targetPath` for the staged binary using the platform's strategy. This is
 * the single mutating step of an upgrade; everything before it is reversible by
 * deleting a scratch directory.
 */
export function applyStaged(
  io: UpgradeIo,
  srcBinPath: string,
  targetPath: string,
  platform: NodeJS.Platform,
): void {
  if (platform === 'win32') replaceWindows(io, srcBinPath, targetPath)
  else replacePosix(io, srcBinPath, targetPath)
}

/**
 * POSIX replace: copy the new binary to a temp file in the SAME directory as the
 * target (so `rename` is atomic and never crosses filesystems), make it
 * executable, self-check it runs, then atomically rename over the target. Any
 * failure before the rename removes the temp file and leaves the original intact.
 */
export function replacePosix(io: UpgradeIo, srcBinPath: string, targetPath: string): void {
  const tmpPath = join(dirname(targetPath), `.c3-upgrade-${process.pid}.tmp`)
  try {
    io.writeFile(tmpPath, io.readFile(srcBinPath))
  } catch (e) {
    safeRemove(io, tmpPath)
    throw new UpgradeError(
      `cannot write to ${dirname(targetPath)} (target not writable?): ${(e as Error).message}`,
      UPGRADE_EXIT.replaceFailed,
    )
  }
  try {
    io.chmod(tmpPath, 0o755)
    io.selfCheckVersion(tmpPath)
    io.rename(tmpPath, targetPath) // atomic overwrite on POSIX
  } catch (e) {
    safeRemove(io, tmpPath)
    if (e instanceof UpgradeError) throw e
    throw new UpgradeError(
      `failed to replace ${targetPath}: ${(e as Error).message}`,
      UPGRADE_EXIT.replaceFailed,
    )
  }
}

/**
 * Windows replace: a running `.exe` cannot be overwritten in place, but it CAN be
 * renamed. Move the current exe aside to `<target>.old`, write the new exe to the
 * original path, then self-check. On any failure the original is renamed back. The
 * `.old` placeholder is left for cleanup on the next run (the running process keeps
 * the old image until it restarts; the path already resolves to the new exe).
 */
export function replaceWindows(io: UpgradeIo, srcBinPath: string, targetPath: string): void {
  const oldPath = `${targetPath}.old`
  // A leftover `.old` from a previous upgrade blocks the rename; clear it first.
  if (io.exists(oldPath)) safeRemove(io, oldPath)
  try {
    io.rename(targetPath, oldPath) // Windows allows renaming a running exe
  } catch (e) {
    throw new UpgradeError(
      `cannot move the running exe aside (target not writable?): ${(e as Error).message}`,
      UPGRADE_EXIT.replaceFailed,
    )
  }
  try {
    io.writeFile(targetPath, io.readFile(srcBinPath))
    io.selfCheckVersion(targetPath)
  } catch (e) {
    // Restore the original so the install is never left broken.
    safeRemove(io, targetPath)
    io.rename(oldPath, targetPath)
    if (e instanceof UpgradeError) throw e
    throw new UpgradeError(
      `failed to place the new exe: ${(e as Error).message}`,
      UPGRADE_EXIT.replaceFailed,
    )
  }
}

function safeRemove(io: UpgradeIo, path: string): void {
  try {
    io.remove(path)
  } catch {
    // best-effort cleanup
  }
}

// ── Restart guidance ────────────────────────────────────────────────────────

/** The precise next-step line(s) to print after a successful replace, given the
 * detected runtime forms. upgrade itself NEVER restarts; it only guides. */
export function restartGuidance(forms: RuntimeForms): string[] {
  if (forms.service || forms.daemonPid !== null) {
    const which = forms.service ? 'OS service' : `background daemon (pid ${forms.daemonPid})`
    return [
      `[c3] a managed instance is running (${which}); it keeps the OLD version until restarted.`,
      `[c3] run 'c3 restart' to start the new version.`,
    ]
  }
  return [`[c3] if c3 is running in this terminal, exit it and re-run c3 to use the new version.`]
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export interface UpgradeOptions {
  /** Only check the latest version; do not download or replace. */
  check?: boolean
  /** Allow reinstalling the SAME version (not a downgrade channel). */
  force?: boolean
  /** `owner/repo` override (testing / emergency). Defaults to {@link DEFAULT_REPO}. */
  repo?: string
  /** Force a specific release target instead of the host's (testing / emergency). */
  target?: string
}

export interface UpgradeDeps {
  platform?: NodeJS.Platform
  arch?: string
  execPath?: string
  version?: string
  home?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  io?: UpgradeIo
  log?: (msg: string) => void
  errlog?: (msg: string) => void
}

/**
 * Run `c3 upgrade`. Returns a process exit code (see {@link UPGRADE_EXIT}). Never
 * throws for an expected failure — each maps to a distinct non-zero code with a
 * stderr explanation; only the final atomic rename mutates the installed binary.
 */
export async function runUpgrade(
  options: UpgradeOptions = {},
  deps: UpgradeDeps = {},
): Promise<number> {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const execPath = deps.execPath ?? process.execPath
  const version = deps.version ?? VERSION
  const home = deps.home ?? c3HomeDir()
  const env = deps.env ?? process.env
  // Same proxy the console's self-update uses: `c3 upgrade` reads the very same
  // system settings, so both entry points reach GitHub over the same route.
  const fetchFn = deps.fetch ?? outboundFetch
  const io = deps.io ?? defaultIo
  const log = deps.log ?? ((m: string) => console.log(m))
  const errlog = deps.errlog ?? ((m: string) => console.error(m))
  const repo = options.repo ?? DEFAULT_REPO

  let tempDir: string | undefined
  try {
    // Refuse self-update for dev/source runs up front (the mutating path only;
    // --check is a harmless version query and is allowed in dev).
    if (!options.check) {
      const updatable = isSelfUpdatable(execPath, version)
      if (!updatable.ok) {
        errlog(`[c3 upgrade] cannot self-update: ${updatable.reason}`)
        errlog(
          `[c3 upgrade] update the source checkout with git/pnpm, or download a release binary`,
        )
        errlog(`[c3 upgrade]   https://github.com/${repo}/releases/latest`)
        return UPGRADE_EXIT.devRefused
      }
    }

    const resolved = await resolveLatestRelease(repo, fetchFn, env)
    const latest = normalizeVersion(resolved.tag)
    const action = decideAction({ current: version, latest, force: options.force })

    if (options.check) {
      if (action === 'update') {
        log(`[c3 upgrade] update available: ${version} → ${latest}`)
        return UPGRADE_EXIT.updateAvailable
      }
      log(`[c3 upgrade] up to date: ${version} (latest ${latest})`)
      return UPGRADE_EXIT.ok
    }

    if (action === 'up-to-date') {
      log(`[c3 upgrade] already up to date: ${version} (latest ${latest})`)
      log(`[c3 upgrade] use --force to reinstall the same version`)
      return UPGRADE_EXIT.ok
    }

    // Select the target for the latest version. On the primary redirect path there
    // is no asset list, so download URLs are derived deterministically from the tag;
    // the fallback JSON path still selects from the enumerated assets.
    const target = options.target ?? hostTarget(platform, arch)
    log(
      action === 'reinstall'
        ? `[c3 upgrade] reinstalling ${latest} (${packageNameFor(latest, target)})`
        : `[c3 upgrade] upgrading ${version} → ${latest} (${packageNameFor(latest, target)})`,
    )

    // Download + verify + unpack into a scratch dir. Nothing installed is touched
    // until the replace below, so any failure here leaves the original in place.
    tempDir = io.mkdtemp('c3-upgrade-')
    const staged = await stageRelease(
      { repo, tag: resolved.tag, version: latest, target, dir: tempDir, assets: resolved.assets },
      { io, fetchFn, env },
    )
    log(
      staged.checksumVerified
        ? `[c3 upgrade] sha256 verified ${staged.pkgName}`
        : `[c3 upgrade] no .sha256 sidecar published — skipping checksum cross-check`,
    )

    // Replace the current binary (atomic on POSIX; placeholder swap on Windows).
    applyStaged(io, staged.binPath, execPath, platform)

    log(`[c3 upgrade] installed ${latest} at ${execPath}`)
    for (const line of restartGuidance(detectRuntimeForms({ platform, c3Home: home }))) log(line)
    return UPGRADE_EXIT.ok
  } catch (e) {
    if (e instanceof UpgradeError) {
      errlog(`[c3 upgrade] ${e.message}`)
      if (e.code === UPGRADE_EXIT.verifyFailed) {
        errlog(
          `[c3 upgrade] refusing to install a corrupted artifact; your current c3 is unchanged`,
        )
      }
      return e.code
    }
    errlog(`[c3 upgrade] unexpected error: ${(e as Error).message}`)
    return UPGRADE_EXIT.error
  } finally {
    if (tempDir) safeRemove(io, tempDir)
  }
}
