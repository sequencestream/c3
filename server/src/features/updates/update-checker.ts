// Server-side update checker: a process-local scheduler that periodically asks
// GitHub "what is the latest c3 release?" and compares that version with the
// running VERSION. The result is a tiny in-memory snapshot the console reads to
// show (or hide) a header upgrade hint. Resolution mirrors the upgrade path:
// the releases redirect first (rate-limit free), the JSON API only as fallback.
//
// A single module-level timer + snapshot, a delayed first check on boot, then a
// fixed 24h cadence, all injectable (endpoint/fetchImpl) so unit tests never
// touch the network.
//
// Fully fail-soft: a fetch error, a non-2xx, malformed JSON, or a missing/illegal
// version never throws into the boot or request path — the last successful
// snapshot is retained and the next tick retries. The checker does NOT self-update
// or persist anything; it only reports.
import {
  DEFAULT_REPO,
  compareVersions,
  normalizeVersion,
  resolveTagViaRedirect,
} from '../../upgrade.js'
import { VERSION } from '../../version.js'
import type { UpdateStatus } from '@ccc/shared/protocol'

/** GitHub releases JSON API for the c3 repository — the *fallback* endpoint only.
 *  Overridable via `C3_UPDATE_CHECK_URL` (e.g. a mirror or a private fork); an
 *  override skips the redirect path entirely and is queried directly. */
const DEFAULT_UPDATE_CHECK_URL = `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`

/** The endpoint override, when one is configured (empty/unset → use the default path). */
function updateCheckUrlOverride(): string | undefined {
  return process.env.C3_UPDATE_CHECK_URL?.trim() || undefined
}

/** Token-aware headers for the JSON-API fallback: a token lifts the 60/h/IP limit. */
function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'c3-update-checker',
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** Delay before the first check so the server can settle on boot (ms). */
const INITIAL_DELAY_MS = 5000
/** Fixed poll cadence once running: check once a day (ms). */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

// The current snapshot. Initial state is "unknown but invisible": no update, no
// known version, never checked. A failed check leaves this untouched; only a
// successful check overwrites it.
let snapshot: UpdateStatus = { available: false, latestVersion: null, checkedAt: null }

/** The current update-availability snapshot (read by the `ready` frame + broadcaster). */
export function currentUpdateStatus(): UpdateStatus {
  return snapshot
}

/** Reset the in-memory snapshot to its initial state (tests only). */
export function resetUpdateStatusForTests(): void {
  snapshot = { available: false, latestVersion: null, checkedAt: null }
}

interface GithubReleaseResponse {
  // GitHub returns the git tag (e.g. "v1.2.3"); some mirrors expose a bare `version`.
  tag_name?: string
  version?: string
  name?: string
}

/** Commit a resolved raw tag/version string to the snapshot. */
function commitSnapshot(latestRaw: string, now?: number): UpdateStatus {
  const latestVersion = normalizeVersion(latestRaw)
  snapshot = {
    available: compareVersions(latestVersion, VERSION) > 0,
    latestVersion,
    checkedAt: now ?? Date.now(),
  }
  return snapshot
}

/**
 * Run one update check and update the in-memory snapshot on success. The primary
 * path parses the release tag out of the `github.com/<repo>/releases/latest`
 * redirect — no token, no `api.github.com` rate limit (60/h/IP, which shared-exit
 * users exhaust and then see HTTP 403). Only when that yields no tag (or an explicit
 * `C3_UPDATE_CHECK_URL` override is configured) do we query the JSON API, with a
 * `GITHUB_TOKEN`/`GH_TOKEN` bearer when present.
 *
 * Never throws. On any failure (network / non-2xx / malformed JSON / missing-or-illegal
 * version) the previous snapshot is preserved and returned unchanged.
 */
export async function runUpdateCheckOnce(
  opts: { url?: string; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<UpdateStatus> {
  const override = opts.url ?? updateCheckUrlOverride()
  const doFetch = opts.fetchImpl ?? fetch

  if (!override) {
    const tag = await resolveTagViaRedirect(DEFAULT_REPO, doFetch, 'c3-update-checker')
    if (tag) return commitSnapshot(tag, opts.now)
    console.log('[c3:update] release redirect gave no tag; falling back to the GitHub API')
  }

  const url = override ?? DEFAULT_UPDATE_CHECK_URL
  let resp: Response
  try {
    resp = await doFetch(url, { method: 'GET', headers: apiHeaders() })
  } catch (e) {
    console.log(`[c3:update] latest-version check network error: ${(e as Error).message}`)
    return snapshot // keep the last known snapshot; retry next tick
  }

  if (!resp.ok) {
    const rateLimited = resp.status === 403 && resp.headers?.get('x-ratelimit-remaining') === '0'
    const hint = rateLimited ? ' (GitHub API rate limit; set GITHUB_TOKEN to raise it)' : ''
    console.log(
      `[c3:update] latest-version check http ${resp.status}${hint}; keeping last snapshot`,
    )
    return snapshot
  }

  let body: GithubReleaseResponse
  try {
    body = (await resp.json()) as GithubReleaseResponse
  } catch {
    console.log('[c3:update] latest-version check: malformed response; keeping last snapshot')
    return snapshot
  }

  const rawTag = body.tag_name ?? body.version ?? body.name
  const latestRaw = typeof rawTag === 'string' ? rawTag.trim() : ''
  if (!latestRaw) {
    console.log('[c3:update] latest-version check: missing/illegal version; keeping last snapshot')
    return snapshot
  }

  return commitSnapshot(latestRaw, opts.now)
}

let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Start the process-local update-check loop. `onChange` is invoked after every
 * check so the caller can broadcast the refreshed snapshot. A brief initial delay
 * lets the server settle on boot, then it self-reschedules on a fixed 24h cadence.
 * Idempotent — a prior loop is stopped first (no multiplexed loops). Fail-soft.
 */
export function startUpdateCheckScheduler(
  opts: { onChange?: () => void; url?: string; fetchImpl?: typeof fetch } = {},
): void {
  stopUpdateCheckScheduler()
  const tick = async (): Promise<void> => {
    try {
      await runUpdateCheckOnce({ url: opts.url, fetchImpl: opts.fetchImpl })
      opts.onChange?.()
    } catch {
      /* fail-soft: never let an update check crash the server */
    }
    timer = setTimeout(() => void tick(), CHECK_INTERVAL_MS)
    timer.unref?.()
  }
  timer = setTimeout(() => void tick(), INITIAL_DELAY_MS)
  timer.unref?.()
}

/** Stop the update-check loop (called on shutdown). */
export function stopUpdateCheckScheduler(): void {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
}
