/**
 * `c3 upgrade` — self-update the installed single binary from GitHub Releases.
 *
 * Flow: resolve runtime form → resolve the latest release tag (GitHub Releases
 * redirect first, JSON API only as fallback) → pick this platform's
 * package → download package + `.sha256` → cross-check the PACKAGE bytes against
 * the published sha256 checksum → unpack the inner `c3`/`c3.exe` → replace the
 * current binary with a same-directory temp file + atomic rename (POSIX) or a
 * `.exe.old` placeholder swap (Windows, where a running exe cannot be overwritten
 * in place). Any failure before the final rename leaves the original binary intact.
 *
 * Hard rules (see doc/non-functional/release.md + the spec):
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
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { c3HomeDir } from './kernel/config/index.js'
import { isInterpreter } from './daemon.js'
import { detectRuntimeForms, type RuntimeForms } from './restart.js'
import { VERSION } from './version.js'

/** Default GitHub repo serving c3 releases (overridable via `--repo` for tests/emergencies). */
export const DEFAULT_REPO = 'sequencestream/c3'

/** The c3 binary basename inside a release package — always `c3`/`c3.exe`. */
function binaryNameFor(target: string): string {
  return target.startsWith('windows') ? 'c3.exe' : 'c3'
}

/**
 * Exit-code contract (scripts may depend on the three classes being distinct):
 *   - `ok` (0): upgraded, or already at the latest version.
 *   - `updateAvailable` (10): `--check` found a newer release (no download/replace).
 *   - everything else: a non-zero error class, each with stderr explanation.
 */
export const UPGRADE_EXIT = {
  ok: 0,
  updateAvailable: 10,
  error: 1,
  devRefused: 3,
  network: 4,
  noArtifact: 5,
  verifyFailed: 6,
  unpackFailed: 7,
  replaceFailed: 8,
} as const

/** A failure carrying the precise upgrade exit code; runUpgrade maps it to stderr + code. */
export class UpgradeError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message)
    this.name = 'UpgradeError'
  }
}

// ── Version comparison ──────────────────────────────────────────────────────

/** Strip a single leading `v` (mirrors scripts/release/artifact-name.mjs). */
export function normalizeVersion(version: string): string {
  return String(version).replace(/^v/, '')
}

interface Semver {
  nums: [number, number, number]
  pre: string[]
}

function parseSemver(version: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(normalizeVersion(version).trim())
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

/**
 * Semver-ish comparison. Returns >0 when `a` is newer, <0 when older, 0 when equal.
 * A leading `v` is normalized; a version WITH a prerelease ranks below the same core
 * WITHOUT one (`1.0.0-rc < 1.0.0`). Unparseable inputs fall back to string compare.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) {
    const na = normalizeVersion(a)
    const nb = normalizeVersion(b)
    return na < nb ? -1 : na > nb ? 1 : 0
  }
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  // Equal core. No-prerelease outranks a prerelease.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  const n = Math.min(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1 // numeric identifiers rank below alphanumeric ones
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return pa.pre.length < pb.pre.length ? -1 : pa.pre.length > pb.pre.length ? 1 : 0
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

/** `c3-v{ver}-{target}{.ext}` — the release package basename (mirrors packageName). */
export function packageNameFor(version: string, target: string): string {
  return `c3-v${normalizeVersion(version)}-${target}${packageExt(target)}`
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

// ── Upgrade decision ────────────────────────────────────────────────────────

export type UpgradeAction = 'up-to-date' | 'update' | 'reinstall'

/**
 * Decide what to do given the current and latest versions. `--force` permits a
 * SAME-version reinstall only; it is never a downgrade channel, so a latest that
 * is older than current is reported as up-to-date regardless of force.
 */
export function decideAction(opts: {
  current: string
  latest: string
  force?: boolean
}): UpgradeAction {
  const cmp = compareVersions(opts.latest, opts.current)
  if (cmp > 0) return 'update'
  if (cmp === 0) return opts.force ? 'reinstall' : 'up-to-date'
  return 'up-to-date' // latest is older — never downgrade
}

// ── GitHub release model + asset selection ──────────────────────────────────

export interface ReleaseAsset {
  name: string
  url: string
}

export interface LatestRelease {
  tag: string
  assets: ReleaseAsset[]
}

/**
 * What the orchestrator needs to proceed after latest-version resolution: the
 * release `tag`. `assets` is populated ONLY when resolution fell back to the JSON
 * API; on the primary redirect path it is absent and download URLs are derived
 * deterministically from the tag (no asset enumeration).
 */
export interface ResolvedRelease {
  tag: string
  assets?: ReleaseAsset[]
}

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
 * Extract a release tag from a GitHub Releases redirect `Location` header. GitHub
 * redirects `.../releases/latest` to `.../releases/tag/<tag>`; the target may be
 * absolute or relative, so match the `/releases/tag/<tag>` path segment anywhere
 * in the value. Returns the (URL-decoded) tag, or null when the header is missing
 * or does not name a tag — the caller treats null as "fall back to the JSON API".
 */
export function parseTagFromLocation(location: string | null | undefined): string | null {
  if (!location) return null
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location)
  if (!m) return null
  const tag = decodeURIComponent(m[1])
  return tag.length > 0 ? tag : null
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
  /** Extract `archivePath` into `destDir` using the platform archive tool. */
  unpack(archivePath: string, destDir: string, target: string): void
  /** Run `binPath --version`; resolves on success, throws on a non-runnable binary. */
  selfCheckVersion(binPath: string): string
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
  unpack: defaultUnpack,
  selfCheckVersion: defaultSelfCheck,
}

// ── Binary replacement strategies ───────────────────────────────────────────

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

// ── Network ─────────────────────────────────────────────────────────────────

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'c3-upgrade',
    Accept: 'application/vnd.github+json',
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchLatestRelease(
  repo: string,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<LatestRelease> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  let res: Response
  try {
    res = await fetchFn(url, { headers: githubHeaders(env) })
  } catch (e) {
    throw new UpgradeError(
      `cannot reach GitHub (offline / proxy-blocked?): ${(e as Error).message}`,
      UPGRADE_EXIT.network,
    )
  }
  if (!res.ok) {
    const rateLimited = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
    const hint = rateLimited ? ' — GitHub API rate limit hit; set GITHUB_TOKEN to raise it' : ''
    throw new UpgradeError(
      `GitHub release query failed: HTTP ${res.status} for ${url}${hint}`,
      UPGRADE_EXIT.network,
    )
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (e) {
    throw new UpgradeError(
      `malformed GitHub release response: ${(e as Error).message}`,
      UPGRADE_EXIT.network,
    )
  }
  const obj = body as { tag_name?: unknown; assets?: unknown }
  if (typeof obj.tag_name !== 'string') {
    throw new UpgradeError('GitHub release response missing tag_name', UPGRADE_EXIT.network)
  }
  const assets: ReleaseAsset[] = Array.isArray(obj.assets)
    ? obj.assets
        .filter(
          (a): a is { name: string; browser_download_url: string } =>
            typeof a === 'object' &&
            a !== null &&
            typeof (a as { name?: unknown }).name === 'string' &&
            typeof (a as { browser_download_url?: unknown }).browser_download_url === 'string',
        )
        .map((a) => ({ name: a.name, url: a.browser_download_url }))
    : []
  return { tag: obj.tag_name, assets }
}

/**
 * Primary latest-version resolver: ask `github.com/{repo}/releases/latest` with
 * `redirect: 'manual'` and read the release tag out of the `Location` header. This
 * avoids the unauthenticated `api.github.com` rate limit (60/h/IP) that shared-exit
 * users hit. Returns null on any unusable outcome (fetch error, no `Location`, or a
 * `Location` that does not name a tag) so the caller can fall back to the JSON API.
 */
async function resolveTagViaRedirect(repo: string, fetchFn: typeof fetch): Promise<string | null> {
  const url = `https://github.com/${repo}/releases/latest`
  let res: Response
  try {
    res = await fetchFn(url, { redirect: 'manual', headers: { 'User-Agent': 'c3-upgrade' } })
  } catch {
    return null
  }
  return parseTagFromLocation(res.headers.get('location'))
}

/**
 * Resolve the latest release. The primary path parses the tag from the GitHub
 * Releases redirect (no asset list, no token, no API rate limit); download URLs are
 * then derived deterministically by {@link buildDownloadUrls}. Only when the redirect
 * yields no usable tag do we fall back to {@link fetchLatestRelease} (JSON API), which
 * keeps the token-aware headers, asset-list selection, and the 403 rate-limit hint.
 */
async function resolveLatestRelease(
  repo: string,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedRelease> {
  const tag = await resolveTagViaRedirect(repo, fetchFn)
  if (tag) return { tag }
  return fetchLatestRelease(repo, fetchFn, env)
}

async function downloadBuffer(
  url: string,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  let res: Response
  try {
    res = await fetchFn(url, { headers: githubHeaders(env) })
  } catch (e) {
    throw new UpgradeError(
      `download failed for ${url}: ${(e as Error).message}`,
      UPGRADE_EXIT.network,
    )
  }
  if (!res.ok) {
    throw new UpgradeError(`download failed for ${url}: HTTP ${res.status}`, UPGRADE_EXIT.network)
  }
  return Buffer.from(await res.arrayBuffer())
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
  const fetchFn = deps.fetch ?? fetch
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

    // Select the target + assets for the latest version. On the primary redirect
    // path there is no asset list, so download URLs are derived deterministically
    // from the tag; the fallback JSON path still selects from the enumerated assets.
    const target = options.target ?? hostTarget(platform, arch)
    const pkgName = packageNameFor(latest, target)
    const selected = resolved.assets
      ? selectAssets(resolved.assets, pkgName)
      : buildDownloadUrls(repo, resolved.tag, pkgName)
    log(
      action === 'reinstall'
        ? `[c3 upgrade] reinstalling ${latest} (${pkgName})`
        : `[c3 upgrade] upgrading ${version} → ${latest} (${pkgName})`,
    )

    // Download package + sha256 sidecar into a scratch dir.
    tempDir = io.mkdtemp('c3-upgrade-')
    const pkgPath = join(tempDir, selected.pkgName)
    io.writeFile(pkgPath, await downloadBuffer(selected.pkgUrl, fetchFn, env))
    const sha256Line = selected.sha256Url
      ? (await downloadBuffer(selected.sha256Url, fetchFn, env)).toString('utf-8')
      : undefined

    // Integrity gate: cross-check the PACKAGE bytes against the published .sha256
    // sidecar before unpacking. (The sha256 checksum + GitHub HTTPS are the integrity
    // anchor.) A missing sidecar is tolerated — the transport is already
    // TLS-authenticated to github.com.
    if (sha256Line && sha256Line.trim() !== '') {
      const actual = createHash('sha256').update(io.readFile(pkgPath)).digest('hex')
      const expected = sha256Line.trim().split(/\s+/)[0]?.toLowerCase()
      if (expected && expected !== actual) {
        errlog(`[c3 upgrade] sha256 mismatch (have ${actual}, expected ${expected})`)
        errlog(
          `[c3 upgrade] refusing to install a corrupted artifact; your current c3 is unchanged`,
        )
        return UPGRADE_EXIT.verifyFailed
      }
      log(`[c3 upgrade] sha256 verified ${selected.pkgName}`)
    } else {
      log(`[c3 upgrade] no .sha256 sidecar published — skipping checksum cross-check`)
    }

    // Unpack into the (already-created) scratch dir and locate the inner binary.
    // Package contents are flat (c3, c3.sha256); their names don't collide with the
    // downloaded package-level files (c3-v…{.tar.gz,.sha256}).
    io.unpack(pkgPath, tempDir, target)
    const innerBin = join(tempDir, binaryNameFor(target))
    if (!io.exists(innerBin)) {
      throw new UpgradeError(
        `unpacked archive is missing the expected binary ${binaryNameFor(target)}`,
        UPGRADE_EXIT.unpackFailed,
      )
    }

    // Replace the current binary (atomic on POSIX; placeholder swap on Windows).
    if (platform === 'win32') replaceWindows(io, innerBin, execPath)
    else replacePosix(io, innerBin, execPath)

    log(`[c3 upgrade] installed ${latest} at ${execPath}`)
    for (const line of restartGuidance(detectRuntimeForms({ platform, c3Home: home }))) log(line)
    return UPGRADE_EXIT.ok
  } catch (e) {
    if (e instanceof UpgradeError) {
      errlog(`[c3 upgrade] ${e.message}`)
      return e.code
    }
    errlog(`[c3 upgrade] unexpected error: ${(e as Error).message}`)
    return UPGRADE_EXIT.error
  } finally {
    if (tempDir) safeRemove(io, tempDir)
  }
}
