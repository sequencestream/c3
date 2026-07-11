// Server-side update checker: a process-local scheduler that periodically asks
// the GitHub releases API "what is the latest c3 release?" and compares that
// version with the running VERSION. The result is a tiny in-memory snapshot the
// console reads to show (or hide) a header upgrade hint.
//
// A single module-level timer + snapshot, a delayed first check on boot, then a
// fixed 24h cadence, all injectable (endpoint/fetchImpl) so unit tests never
// touch the network.
//
// Fully fail-soft: a fetch error, a non-2xx, malformed JSON, or a missing/illegal
// version never throws into the boot or request path — the last successful
// snapshot is retained and the next tick retries. The checker does NOT self-update
// or persist anything; it only reports.
import { compareVersions, normalizeVersion } from '../../upgrade.js'
import { VERSION } from '../../version.js'
import type { UpdateStatus } from '@ccc/shared/protocol'

/** GitHub releases endpoint for the c3 repository (latest published release).
 *  Overridable via `C3_UPDATE_CHECK_URL` (e.g. a mirror or a private fork). */
const DEFAULT_UPDATE_CHECK_URL = 'https://api.github.com/repos/sequencestream/c3/releases/latest'

/** Resolve the update-check endpoint: env override wins, else the GitHub default. */
function updateCheckUrl(): string {
  const env = process.env.C3_UPDATE_CHECK_URL?.trim()
  return env || DEFAULT_UPDATE_CHECK_URL
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

/**
 * Run one update check against the GitHub releases API and update the in-memory
 * snapshot on success. Never throws. On any failure (network / non-2xx / malformed
 * JSON / missing-or-illegal version) the previous snapshot is preserved and the
 * returned snapshot is simply the current (unchanged) one.
 */
export async function runUpdateCheckOnce(
  opts: { url?: string; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<UpdateStatus> {
  const url = opts.url ?? updateCheckUrl()
  const doFetch = opts.fetchImpl ?? fetch

  let resp: Response
  try {
    resp = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'c3-update-checker' },
    })
  } catch (e) {
    console.log(`[c3:update] latest-version check network error: ${(e as Error).message}`)
    return snapshot // keep the last known snapshot; retry next tick
  }

  if (!resp.ok) {
    console.log(`[c3:update] latest-version check http ${resp.status}; keeping last snapshot`)
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

  const latestVersion = normalizeVersion(latestRaw)
  const available = compareVersions(latestVersion, VERSION) > 0
  snapshot = {
    available,
    latestVersion,
    checkedAt: opts.now ?? Date.now(),
  }
  return snapshot
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
