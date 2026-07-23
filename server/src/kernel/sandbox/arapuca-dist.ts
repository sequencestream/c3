/**
 * arapuca Distribution Manager — c3-managed arapuca install
 *
 * c3 pins ONE verified arapuca version and installs it under
 * `~/.c3/sandbox/arapuca/`, so the process-level sandbox no longer depends on
 * whatever (possibly ancient, possibly broken) arapuca the user happened to put
 * on their PATH. The pinned version is the single source of truth: c3 never
 * tracks `latest` at run time and never keeps a version history.
 *
 * ## Layout
 * ```
 * ~/.c3/sandbox/arapuca/
 *   <version>/arapuca-<version>/arapuca      ← the extracted archive
 *   current -> <version>                     ← switched only after full verify
 *   .install-XXXX/                           ← staging, removed on success/failure
 * ```
 *
 * ## Guarantees
 * - **Verify before activate.** Download → SHA-256 → extract → executable check
 *   all succeed before `current` is switched. A checksum mismatch never reaches
 *   the extractor, so an incomplete/forged tree can never be probed.
 * - **Atomic-ish switch.** `current` is written as a temp symlink and `rename`d
 *   over the old one (POSIX atomic). A failed switch leaves the previous
 *   association intact.
 * - **Never blocks a run.** {@link ensureManagedArapuca} is fire-and-forget and
 *   single-flight per process; failures are logged, never thrown, and never
 *   surface as an unhandled rejection.
 * - **Off unless wired.** Auto-install stays inert until the composition root
 *   calls {@link enableArapucaAutoInstall}, so unit tests and library consumers
 *   never reach the network implicitly.
 *
 * Layer: kernel/sandbox (inner domain)
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { c3HomeDir } from '../config/index.js'

// ─── Pinned Artifact Table ───────────────────────────────────────────────────

/**
 * The arapuca version this c3 build is associated with.
 *
 * 0.2.5 is the first upstream release carrying BOTH macOS Seatbelt fixes c3
 * depends on: mount-ancestor traversal (codex canonicalizes `CODEX_HOME` at
 * startup and dies without it) and `/tmp` symlink resolution (claude hardcodes
 * its runtime dir at `/tmp/claude-<uid>`). Before it, macOS users had to build a
 * patched arapuca by hand. Bumping this constant is a deliberate, verified act:
 * re-run `scripts/e2e/e2e-arapuca-capability-test.mjs` against the new binary
 * and refresh the checksums from the release's `sha256sums.txt`.
 */
export const ARAPUCA_VERSION = '0.2.5'

/** Where the pinned release's artifacts are published. */
const RELEASE_BASE = `https://github.com/sergio-correia/arapuca/releases/download/v${ARAPUCA_VERSION}`

/** A downloadable, checksum-pinned arapuca build for one host platform. */
export interface ArapucaArtifact {
  /** The pinned version — also the install directory name. */
  readonly version: string
  /** Absolute download URL of the release archive. */
  readonly url: string
  /** Expected SHA-256 of the archive bytes (lowercase hex). */
  readonly sha256: string
  /**
   * Path of the executable INSIDE the extracted archive, relative to the
   * install dir (upstream archives nest everything under `arapuca-<version>/`).
   */
  readonly binaryRelPath: string
}

/** Build the artifact entry for a platform whose archive layout is uniform. */
function artifact(file: string, sha256: string, exe = 'arapuca'): ArapucaArtifact {
  return {
    version: ARAPUCA_VERSION,
    url: `${RELEASE_BASE}/${file}`,
    sha256,
    binaryRelPath: join(`arapuca-${ARAPUCA_VERSION}`, exe),
  }
}

/**
 * The pinned per-platform artifact table, keyed `<process.platform>-<process.arch>`.
 * Checksums are copied from the release's signed `sha256sums.txt` and verified
 * against the downloaded bytes. A platform absent from this table is simply not
 * managed by c3 — the probe falls back to the host PATH, it never guesses a
 * near-match artifact and never builds from source.
 */
const ARTIFACTS: Readonly<Record<string, ArapucaArtifact>> = {
  'darwin-arm64': artifact(
    'arapuca-darwin-arm64.tar.gz',
    '131c133fc56fc6e9a25815a1f659a50121c7b3f6aabffb64ab69e8a6f015f42c',
  ),
  'darwin-x64': artifact(
    'arapuca-darwin-x86_64.tar.gz',
    '30ae98a734923683c2cf8700e2c2e00a05a987a18f5438fdd2d84efe529793b5',
  ),
  // The static linux/x64 build is preferred over the dynamic one: it runs on
  // musl and old-glibc hosts alike, which a downloaded binary cannot assume.
  'linux-x64': artifact(
    'arapuca-linux-x86_64-static.tar.gz',
    '51bb8625071f713bf89a95d1361641f24ecfe48155dbfeb7e8a5b5f8a31cbedd',
  ),
  'linux-arm64': artifact(
    'arapuca-linux-aarch64.tar.gz',
    '2c79896b8213e474fcab83c7433d3ded87f672431428feef2fc0a57fc4b3d55d',
  ),
  'win32-x64': artifact(
    'arapuca-windows-x86_64.zip',
    'a14eb6f8414230a84aa5047ab473d1e3b594745d029afaaa24ec70dfd83f7bdf',
    'arapuca.exe',
  ),
}

/**
 * The pinned artifact for a host, or null when c3 ships no build for it (the
 * caller then relies on the host PATH alone).
 */
export function artifactForHost(
  platform: string = process.platform,
  arch: string = process.arch,
): ArapucaArtifact | null {
  return ARTIFACTS[`${platform}-${arch}`] ?? null
}

// ─── Managed Root ────────────────────────────────────────────────────────────

/** The c3-managed arapuca root (`~/.c3/sandbox/arapuca`). */
export function managedRootDir(): string {
  return join(c3HomeDir(), 'sandbox', 'arapuca')
}

/** The `current` pointer inside a managed root. */
function currentLink(root: string): string {
  return join(root, 'current')
}

/** Whether `child` is `parent` or lives underneath it (path-segment aware). */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  const p = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(p)
}

/**
 * Resolve the c3-managed arapuca binary, or null when the managed install is
 * absent or untrustworthy.
 *
 * A name alone is never trusted. The `current` pointer must resolve (no dangling
 * link) to a real directory that (a) stays inside the managed root — a link
 * escaping it is treated as absent, never followed — and (b) IS the pinned
 * version's directory, so a stale association from an older c3 build is ignored
 * rather than executed. The binary itself must exist and be executable.
 */
export function resolveManagedArapuca(
  opts: { root?: string; artifact?: ArapucaArtifact | null } = {},
): string | null {
  const art = opts.artifact === undefined ? artifactForHost() : opts.artifact
  if (!art) return null
  let target: string
  let canonRoot: string
  try {
    // Resolving the root can itself fail (no c3 home yet) — that just means
    // "nothing managed here", never a probe-breaking throw.
    const root = opts.root ?? managedRootDir()
    canonRoot = realpathSync(root)
    target = realpathSync(currentLink(root))
  } catch {
    // No managed install yet, or a dangling `current`.
    return null
  }
  // Out-of-root or wrong-version association: not ours, do not execute.
  if (!isWithin(target, canonRoot) || target === canonRoot) return null
  if (target !== join(canonRoot, art.version)) return null
  const bin = join(target, art.binaryRelPath)
  try {
    accessSync(bin, fsConstants.X_OK)
  } catch {
    return null
  }
  return bin
}

// ─── Install ─────────────────────────────────────────────────────────────────

/** Why a managed install attempt failed (logged; never surfaced as a UI code). */
export type ArapucaInstallFailure =
  'download-failed' | 'checksum-mismatch' | 'extract-failed' | 'activate-failed'

/** A failed install attempt. The previous association (if any) is untouched. */
export class ArapucaInstallError extends Error {
  readonly reason: ArapucaInstallFailure
  constructor(reason: ArapucaInstallFailure, message: string) {
    super(message)
    this.name = 'ArapucaInstallError'
    this.reason = reason
  }
}

/** Fetch `url` into `destFile`. Injectable so unit tests never hit the network. */
export type ArapucaDownloader = (url: string, destFile: string) => Promise<void>

/** Extract `archive` into the (already created) `destDir`. Injectable for tests. */
export type ArapucaExtractor = (archive: string, destDir: string) => void

/**
 * Default downloader — `fetch`, falling back to `curl`.
 *
 * Node's `fetch` ignores the standard `HTTP(S)_PROXY` / `NO_PROXY` environment,
 * so on a proxy-bound host it fails outright and the managed install would never
 * materialize. `curl` honours that environment natively (as well as the system
 * trust store), and ships on macOS, modern Windows and virtually every Linux —
 * the same "use the system tool" bargain already made for `tar`. The URL is
 * always the pinned artifact's: this is proxy support, not a configurable mirror.
 */
const httpDownload: ArapucaDownloader = async (url, destFile) => {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    writeFileSync(destFile, Buffer.from(await res.arrayBuffer()))
    return
  } catch (err) {
    const direct = err instanceof Error ? err.message : String(err)
    const r = spawnSync('curl', ['-fsSL', '--retry', '2', '-o', destFile, url], {
      encoding: 'utf-8',
    })
    if (r.error || r.status !== 0) {
      const viaCurl = r.error
        ? r.error.message
        : `curl exited ${r.status} ${(r.stderr || '').trim()}`
      throw new Error(`${direct}; ${viaCurl}`, { cause: err })
    }
  }
}

/**
 * Default extractor — `tar -xf`, which handles BOTH `.tar.gz` and `.zip`:
 * bsdtar (macOS, Windows 10+) reads zip natively and GNU tar auto-detects gzip.
 * Using the system tool keeps c3 free of an archive dependency.
 */
const tarExtract: ArapucaExtractor = (archive, destDir) => {
  const r = spawnSync('tar', ['-xf', archive, '-C', destDir], { encoding: 'utf-8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`tar exited ${r.status}: ${(r.stderr || '').trim()}`)
}

/** SHA-256 of a file's bytes, lowercase hex. */
function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Point `current` at `version`, atomically where the platform allows it.
 *
 * A fresh symlink is created under a temp name in the same directory and
 * `rename`d over the existing pointer — atomic on POSIX, so a concurrent
 * resolver sees either the old or the new association, never a half-written one.
 * Windows cannot rename over an existing junction, so there the old pointer is
 * removed first (a millisecond-wide window in which the probe simply falls back
 * to the host PATH — the same outcome as before the install).
 */
function activateVersion(root: string, version: string): void {
  const link = currentLink(root)
  const tmp = join(root, `.current-${process.pid}-${version}`)
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // best-effort
  }
  // Junctions need an absolute target; POSIX keeps the link relative so the
  // whole managed root stays relocatable.
  if (process.platform === 'win32') symlinkSync(join(root, version), tmp, 'junction')
  else symlinkSync(version, tmp, 'dir')
  try {
    renameSync(tmp, link)
  } catch {
    // Windows (or any FS refusing rename-over-existing): drop, then re-point.
    rmSync(link, { recursive: true, force: true })
    renameSync(tmp, link)
  }
}

/**
 * Download, verify, install and activate the pinned arapuca. Resolves with the
 * absolute path of the installed binary.
 *
 * Everything happens in a staging dir under the SAME managed root, so the final
 * move is a same-filesystem rename. Any failure removes the staging tree and
 * leaves the existing `current` (and the previously installed version) exactly
 * as it was — a broken attempt can never be probed, and can be retried later.
 *
 * @throws {@link ArapucaInstallError}
 */
export async function installArapuca(opts: {
  readonly root: string
  readonly artifact: ArapucaArtifact
  readonly download?: ArapucaDownloader
  readonly extract?: ArapucaExtractor
}): Promise<string> {
  const { root, artifact: art } = opts
  const download = opts.download ?? httpDownload
  const extract = opts.extract ?? tarExtract
  mkdirSync(root, { recursive: true })
  const staging = mkdtempSync(join(root, '.install-'))
  try {
    const archive = join(staging, 'artifact')
    try {
      await download(art.url, archive)
    } catch (err) {
      throw new ArapucaInstallError(
        'download-failed',
        `arapuca download failed (${art.url}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Checksum FIRST: a mismatched archive is never handed to the extractor.
    const actual = sha256File(archive)
    if (actual !== art.sha256) {
      throw new ArapucaInstallError(
        'checksum-mismatch',
        `arapuca checksum mismatch: expected ${art.sha256}, got ${actual}`,
      )
    }
    const unpack = join(staging, 'unpack')
    mkdirSync(unpack, { recursive: true })
    let bin: string
    try {
      extract(archive, unpack)
      bin = join(unpack, art.binaryRelPath)
      // The archive must actually contain the executable we expect.
      chmodSync(bin, 0o755)
      accessSync(bin, fsConstants.X_OK)
    } catch (err) {
      throw new ArapucaInstallError(
        'extract-failed',
        `arapuca extract failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const versionDir = join(root, art.version)
    try {
      // A version dir present here is a leftover from an attempt that never
      // activated (a valid one would have short-circuited this install).
      rmSync(versionDir, { recursive: true, force: true })
      mkdirSync(dirname(versionDir), { recursive: true })
      renameSync(unpack, versionDir)
      activateVersion(root, art.version)
    } catch (err) {
      throw new ArapucaInstallError(
        'activate-failed',
        `arapuca activation failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Canonicalized, so the installer and {@link resolveManagedArapuca} always
    // name the binary identically (macOS `/var` → `/private/var` and friends).
    return join(realpathSync(versionDir), art.binaryRelPath)
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // staging cleanup is best-effort
    }
  }
}

// ─── Background Single-Flight ────────────────────────────────────────────────

/**
 * Auto-install stays OFF until the composition root turns it on. Wiring — not
 * environment sniffing — is what makes a process allowed to reach the network,
 * so unit tests and embedders are never surprised by a background download.
 */
let autoInstallEnabled = false

/** In-flight install, shared by every concurrent probe (single-flight). */
let inflight: Promise<void> | null = null

/** Enable background auto-install (called once by the server composition root). */
export function enableArapucaAutoInstall(): void {
  autoInstallEnabled = true
}

/**
 * Kick off a background install of the pinned arapuca — fire-and-forget.
 *
 * Returns immediately: the caller's probe MUST continue with its host-PATH
 * fallback and settle this run on that result. Concurrent callers (startup
 * probe, settings panel, several runs) share one task, so a version is
 * downloaded at most once per process. Failures are logged and swallowed —
 * never thrown, never an unhandled rejection — and clear the in-flight slot so
 * a later probe in the same process can retry.
 *
 * @param opts.onInstalled Invoked after `current` is switched, so the caller can
 *   invalidate a probe cache that had settled on the host PATH.
 * @param opts.download Overrides the transport, @param opts.extract the
 *   unpacker (tests inject stubs so no unit test ever reaches the network).
 */
export function ensureManagedArapuca(
  opts: {
    onInstalled?: () => void
    download?: ArapucaDownloader
    extract?: ArapucaExtractor
  } = {},
): void {
  if (!autoInstallEnabled || inflight) return
  const art = artifactForHost()
  // Unmapped platform: no artifact, no guessing — the host PATH is the only path.
  if (!art) return
  const root = managedRootDir()
  console.log(`[sandbox] installing c3-managed arapuca ${art.version} in the background`)
  inflight = installArapuca({
    root,
    artifact: art,
    ...(opts.download && { download: opts.download }),
    ...(opts.extract && { extract: opts.extract }),
  })
    .then((bin) => {
      console.log(`[sandbox] c3-managed arapuca ${art.version} ready: ${bin}`)
      opts.onInstalled?.()
    })
    .catch((err: unknown) => {
      const reason = err instanceof ArapucaInstallError ? err.reason : 'download-failed'
      console.warn(
        `[sandbox] c3-managed arapuca install failed (${reason}): ` +
          `${err instanceof Error ? err.message : String(err)} — falling back to host PATH`,
      )
    })
    .finally(() => {
      inflight = null
    })
}

/** Test-only: the in-flight install promise (or null), for awaiting in tests. */
export function pendingArapucaInstallForTests(): Promise<void> | null {
  return inflight
}

/** Test-only: reset the auto-install gate and single-flight slot. */
export function resetArapucaDistForTests(): void {
  autoInstallEnabled = false
  inflight = null
}
