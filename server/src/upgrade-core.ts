/**
 * `upgrade-core.ts` — the shared update kernel for BOTH distribution channels.
 *
 * The CLI's `c3 upgrade` and the desktop shell's in-app updater must agree on the
 * version facts, the transport and the integrity rules — otherwise the desktop app
 * would grow a second trust chain of its own. Everything that decides "is a newer
 * release available", "which artifact do I download" and "is the bytes I got the
 * bytes that were published" lives here as pure, injectable functions:
 *
 *   - version comparison (`normalizeVersion` / `compareVersions` / `decideAction`);
 *   - latest-release resolution (the rate-limit-free `releases/latest` redirect
 *     first, the JSON API only as fallback);
 *   - download + sha256 verification;
 *   - parsing the release manifest and selecting the `desktop` channel artifact
 *     that matches the current platform/arch.
 *
 * Hard constraints shared by both callers:
 *   - NO console output (the CLI prints its own progress; the desktop shell turns
 *     failures into user-visible state, never into stderr).
 *   - NO `process.execPath` assumption — the CLI passes the binary it wants to
 *     replace; the desktop shell never swaps a binary at all.
 *   - platform / arch are injected, never read from `process`.
 *   - every expected failure is an {@link UpgradeError} carrying a stable code
 *     (`UPGRADE_EXIT`), so callers can map it to their own UX without string matching.
 */
import { createHash } from 'node:crypto'

/** Default GitHub repo serving c3 releases (overridable via `--repo` for tests/emergencies). */
export const DEFAULT_REPO = 'sequencestream/c3'

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

/** A failure carrying the precise upgrade exit code; callers map it to their own UX. */
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

export type UpgradeAction = 'up-to-date' | 'update' | 'reinstall'

/**
 * Decide what to do given the current and latest versions. `force` permits a
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

// ── GitHub release model ────────────────────────────────────────────────────

export interface ReleaseAsset {
  name: string
  url: string
}

export interface LatestRelease {
  tag: string
  assets: ReleaseAsset[]
}

/**
 * What the caller needs to proceed after latest-version resolution: the release
 * `tag`. `assets` is populated ONLY when resolution fell back to the JSON API; on
 * the primary redirect path it is absent and download URLs are derived
 * deterministically from the tag (no asset enumeration).
 */
export interface ResolvedRelease {
  tag: string
  assets?: ReleaseAsset[]
}

/** Token-aware headers for the GitHub JSON-API fallback path. */
export function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'c3-upgrade',
    Accept: 'application/vnd.github+json',
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
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
 * Primary latest-version resolver: ask `github.com/{repo}/releases/latest` with
 * `redirect: 'manual'` and read the release tag out of the `Location` header. This
 * avoids the unauthenticated `api.github.com` rate limit (60/h/IP) that shared-exit
 * users hit. Returns null on any unusable outcome (fetch error, no `Location`, or a
 * `Location` that does not name a tag) so the caller can fall back to the JSON API.
 */
export async function resolveTagViaRedirect(
  repo: string,
  fetchFn: typeof fetch,
  userAgent = 'c3-upgrade',
): Promise<string | null> {
  const url = `https://github.com/${repo}/releases/latest`
  let res: Response
  try {
    res = await fetchFn(url, { redirect: 'manual', headers: { 'User-Agent': userAgent } })
  } catch {
    return null
  }
  return parseTagFromLocation(res.headers.get('location'))
}

/** Query the GitHub JSON API for the latest release (the fallback path). */
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
 * Resolve the latest release. The primary path parses the tag from the GitHub
 * Releases redirect (no asset list, no token, no API rate limit); download URLs are
 * then derived deterministically. Only when the redirect yields no usable tag do we
 * fall back to the JSON API, which keeps the token-aware headers and asset list.
 */
export async function resolveLatestRelease(
  repo: string,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedRelease> {
  const tag = await resolveTagViaRedirect(repo, fetchFn)
  if (tag) return { tag }
  return fetchLatestRelease(repo, fetchFn, env)
}

// ── Download + verification ─────────────────────────────────────────────────

/** Download a whole resource to memory. Every failure maps to a stable error code. */
export async function downloadBuffer(
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

/** SHA-256 hex digest of the given bytes. */
export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Parse the leading hex token of a `.sha256` sidecar line (first whitespace field). */
export function parseSha256Line(line: string): string | null {
  const token = line.trim().split(/\s+/)[0]
  return token && /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null
}

/** True when `actual` matches `expected` (both lowercased hex). */
export function verifySha256(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase()
}

/** Deterministic download URL for a release asset, given a known release tag. */
export function releaseDownloadUrl(repo: string, tag: string, fileName: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/${fileName}`
}

// ── Release manifest + desktop channel selection ────────────────────────────

/** One entry of the release manifest (`c3-release-manifest/v1.3`). */
export interface ManifestArtifact {
  target: string
  platform: string
  arch: string
  channel: string
  kind?: string
  file: string
  bytes: number
  sha256: string
  /** The publish convention's single preferred installer for this platform. */
  preferred?: boolean
}

export interface ReleaseManifest {
  schema: string
  version: string
  artifacts: ManifestArtifact[]
}

/** Is this a manifest payload the updater can consume? (schema family check only.) */
export function isReleaseManifestSchema(schema: unknown): boolean {
  return typeof schema === 'string' && schema.startsWith('c3-release-manifest/')
}

/**
 * Parse + validate an untrusted manifest payload. Missing/invalid schema, missing
 * version, or an entry lacking the integrity trio (file / bytes / sha256) all fail
 * closed with `verifyFailed` — the desktop updater never skips the checksum.
 */
export function parseManifest(json: unknown): ReleaseManifest {
  if (typeof json !== 'object' || json === null) {
    throw new UpgradeError('update manifest is not an object', UPGRADE_EXIT.verifyFailed)
  }
  const obj = json as { schema?: unknown; version?: unknown; artifacts?: unknown }
  const schema = typeof obj.schema === 'string' ? obj.schema : ''
  if (!isReleaseManifestSchema(schema)) {
    throw new UpgradeError(
      `update manifest has an unknown schema (${String(obj.schema)})`,
      UPGRADE_EXIT.verifyFailed,
    )
  }
  const version = typeof obj.version === 'string' ? obj.version : ''
  if (version.trim() === '') {
    throw new UpgradeError('update manifest is missing its version', UPGRADE_EXIT.verifyFailed)
  }
  if (!Array.isArray(obj.artifacts)) {
    throw new UpgradeError(
      'update manifest is missing its artifact list',
      UPGRADE_EXIT.verifyFailed,
    )
  }
  const artifacts: ManifestArtifact[] = obj.artifacts.map((raw, i) => {
    const a = raw as {
      target?: unknown
      platform?: unknown
      arch?: unknown
      channel?: unknown
      kind?: unknown
      file?: unknown
      bytes?: unknown
      sha256?: unknown
      preferred?: unknown
    }
    if (
      typeof a.file !== 'string' ||
      typeof a.bytes !== 'number' ||
      typeof a.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(a.sha256)
    ) {
      throw new UpgradeError(
        `update manifest artifact #${i} is missing file/bytes/sha256`,
        UPGRADE_EXIT.verifyFailed,
      )
    }
    return {
      target: typeof a.target === 'string' ? a.target : '',
      platform: typeof a.platform === 'string' ? a.platform : '',
      arch: typeof a.arch === 'string' ? a.arch : '',
      channel: typeof a.channel === 'string' ? a.channel : 'cli',
      ...(typeof a.kind === 'string' ? { kind: a.kind } : {}),
      file: a.file,
      bytes: a.bytes,
      sha256: a.sha256.toLowerCase(),
      ...(a.preferred === true ? { preferred: true } : {}),
    }
  })
  return { schema, version, artifacts }
}

/**
 * Fetch + parse the release manifest for a tag. The manifest is uploaded to the
 * Release alongside the artifacts (publish step), so it lives at the deterministic
 * download URL for that tag.
 */
export async function fetchReleaseManifest(
  repo: string,
  tag: string,
  fetchFn: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<ReleaseManifest> {
  const url = releaseDownloadUrl(repo, tag, 'manifest.json')
  const raw = await downloadBuffer(url, fetchFn, env)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf-8'))
  } catch (e) {
    throw new UpgradeError(
      `update manifest is not valid JSON: ${(e as Error).message}`,
      UPGRADE_EXIT.verifyFailed,
    )
  }
  return parseManifest(parsed)
}

/**
 * Select the single `desktop` channel artifact for the current platform/arch.
 *
 * Rules (fail closed — never guess):
 *   - only `channel: desktop` entries are candidates;
 *   - the manifest version must equal the release version being targeted;
 *   - platform/arch must match the current install exactly;
 *   - when the publish convention marked one entry `preferred`, that entry wins;
 *   - otherwise a SINGLE matching candidate is accepted; zero or several candidates
 *     without a unique preferred marker are both rejected.
 */
export function selectDesktopArtifact(
  manifest: ReleaseManifest,
  opts: { platform: string; arch: string; version: string },
): ManifestArtifact {
  if (normalizeVersion(manifest.version) !== normalizeVersion(opts.version)) {
    throw new UpgradeError(
      `update manifest version ${manifest.version} does not match target release ${opts.version}`,
      UPGRADE_EXIT.noArtifact,
    )
  }
  const matches = manifest.artifacts.filter(
    (a) => a.channel === 'desktop' && a.platform === opts.platform && a.arch === opts.arch,
  )
  const preferred = matches.filter((a) => a.preferred === true)
  if (preferred.length === 1) return preferred[0]
  if (matches.length === 1) return matches[0]
  throw new UpgradeError(
    `no single desktop artifact for ${opts.platform}-${opts.arch} @ ${opts.version} ` +
      `(candidates: ${matches.length}) — refusing to guess`,
    UPGRADE_EXIT.noArtifact,
  )
}

/**
 * Cross-check the package bytes against BOTH published checksums: the manifest's
 * `sha256` and the release's `<package>.sha256` sidecar. A missing/malformed
 * sidecar, or a mismatch between the two, is a failure — the desktop updater never
 * tolerates a missing checksum the way the CLI compatibility path may.
 */
export function verifyDoubleChecksum(opts: {
  data: Buffer
  manifestSha256: string
  sidecarLine?: string | null
}): void {
  if (!verifySha256(sha256Hex(opts.data), opts.manifestSha256)) {
    throw new UpgradeError(
      'downloaded artifact does not match the manifest sha256',
      UPGRADE_EXIT.verifyFailed,
    )
  }
  const expected = opts.sidecarLine != null ? parseSha256Line(opts.sidecarLine) : null
  if (!expected) {
    throw new UpgradeError(
      'the release did not publish a usable .sha256 sidecar — refusing to install',
      UPGRADE_EXIT.verifyFailed,
    )
  }
  if (!verifySha256(sha256Hex(opts.data), expected)) {
    throw new UpgradeError(
      'downloaded artifact does not match the release .sha256 sidecar',
      UPGRADE_EXIT.verifyFailed,
    )
  }
}
