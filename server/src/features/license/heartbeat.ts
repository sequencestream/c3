// c3-side heartbeat: a process-local scheduler that confirms the live binding
// with LS at the interval LS dictates (ADR-0026, PL-R3/PL-R4/PL-R8). It presents
// the per-binding alive token; LS answers with the current status and, when still
// entitled, a refreshed signed entitlement token.
//
// Fail-soft (PL-R13): a heartbeat error never throws into the run path. A network
// failure runs the 30-minute offline grace (PL-R4); a definitive `disabled`/
// `expired` verdict lapses the cache to gated (PL-R8). `disabled` — the license
// was rebound to another installation — is gated, not grace-recoverable: "one
// license, one installation".
import { licenseServerBaseUrl } from './activation.js'
import {
  readLicenseCache,
  recordHeartbeatFailure,
  recordHeartbeatLapse,
  recordHeartbeatSuccess,
} from './store.js'
import { verifyEntitlementToken } from './token.js'

/** Fallback interval when LS does not dictate one (seconds). */
const DEFAULT_INTERVAL_SECONDS = 3600

interface HeartbeatResponse {
  status?: string
  entitlementToken?: string
  termEnd?: number
  heartbeatIntervalSeconds?: number
}

export type HeartbeatOutcome =
  | { changed: boolean; status: string; intervalSeconds: number }
  | { changed: boolean; status: 'skipped' | 'error'; intervalSeconds: number; reason: string }

/**
 * Run one heartbeat against LS and update the cache accordingly. Never throws.
 * Returns the resolved next interval so the scheduler can reschedule.
 */
export async function runHeartbeatOnce(
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<HeartbeatOutcome> {
  const cache = readLicenseCache()
  if (!cache || !cache.licenseKey || !cache.aliveToken) {
    return {
      changed: false,
      status: 'skipped',
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      reason: 'unactivated',
    }
  }
  const baseUrl = opts.baseUrl ?? licenseServerBaseUrl()
  const doFetch = opts.fetchImpl ?? fetch

  let resp: Response
  try {
    resp = await doFetch(new URL('/v1/license/heartbeat', baseUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        licenseKey: cache.licenseKey,
        installationId: cache.installationId,
        aliveToken: cache.aliveToken,
      }),
    })
  } catch (e) {
    recordHeartbeatFailure()
    return {
      changed: true,
      status: 'error',
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      reason: `network: ${(e as Error).message}`,
    }
  }

  if (!resp.ok) {
    // Unknown key / server error: treat as a failing heartbeat (grace), not a
    // definitive lapse — a transient 5xx must not gate within the grace window.
    recordHeartbeatFailure()
    return {
      changed: true,
      status: 'error',
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      reason: `http_${resp.status}`,
    }
  }

  let body: HeartbeatResponse
  try {
    body = (await resp.json()) as HeartbeatResponse
  } catch {
    recordHeartbeatFailure()
    return {
      changed: true,
      status: 'error',
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      reason: 'malformed response',
    }
  }

  const interval =
    body.heartbeatIntervalSeconds && body.heartbeatIntervalSeconds > 0
      ? body.heartbeatIntervalSeconds
      : DEFAULT_INTERVAL_SECONDS

  switch (body.status) {
    case 'active': {
      // Verify any refreshed token offline before caching (PL-R5).
      if (body.entitlementToken) {
        const v = verifyEntitlementToken(body.entitlementToken)
        if (!v.ok || v.payload.installationId !== cache.installationId) {
          recordHeartbeatFailure()
          return {
            changed: true,
            status: 'error',
            intervalSeconds: interval,
            reason: 'token verification failed',
          }
        }
      }
      recordHeartbeatSuccess({
        entitlementToken: body.entitlementToken,
        termEnd: body.termEnd,
      })
      return { changed: true, status: 'active', intervalSeconds: interval }
    }
    case 'disabled':
      recordHeartbeatLapse('disabled')
      return { changed: true, status: 'disabled', intervalSeconds: interval }
    case 'expired':
      recordHeartbeatLapse('expired')
      return { changed: true, status: 'expired', intervalSeconds: interval }
    default:
      recordHeartbeatFailure()
      return {
        changed: true,
        status: 'error',
        intervalSeconds: interval,
        reason: `unknown status ${String(body.status)}`,
      }
  }
}

let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Start the process-local heartbeat loop. `onChange` is invoked after each beat
 * so the caller can push the refreshed license state (PL-R7). Self-reschedules at
 * the interval LS dictates; fully fail-soft. Idempotent — a prior loop is stopped
 * first. The first beat is delayed briefly so the server can settle on boot.
 */
export function startHeartbeatScheduler(
  opts: { onChange?: () => void; baseUrl?: string; fetchImpl?: typeof fetch } = {},
): void {
  stopHeartbeatScheduler()
  const tick = async (): Promise<void> => {
    let interval = DEFAULT_INTERVAL_SECONDS
    try {
      const outcome = await runHeartbeatOnce({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl })
      interval = outcome.intervalSeconds
      opts.onChange?.()
    } catch {
      /* fail-soft: never let a heartbeat crash the server */
    }
    timer = setTimeout(() => void tick(), interval * 1000)
    timer.unref?.()
  }
  timer = setTimeout(() => void tick(), 5000)
  timer.unref?.()
}

/** Stop the heartbeat loop (called on shutdown). */
export function stopHeartbeatScheduler(): void {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
}
