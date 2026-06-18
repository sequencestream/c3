/**
 * `license` feature handlers (ADR-0026 product-license). Two read/drive actions:
 * fetch the current entitlement state for the badge/menu, and open the LS landing
 * page to bind a license in the browser (the bind itself happens there; c3 polls
 * `checkbind` to collect the result — see {@link startActivation}). The heartbeat
 * scheduler lives in `heartbeat.ts` (started at server boot). Handlers are
 * `(ctx, conn, msg)` (ADR-0009).
 */
import type { Handler } from '../../transport/handler-registry.js'
import { startActivation } from './activation.js'
import { runHeartbeatOnce } from './heartbeat.js'
import { currentLicenseStatus } from './store.js'

/** Reply with the current license state (drives the badge/menu, PL-R7). */
export const getLicense: Handler<'get_license'> = (_ctx, conn) => {
  conn.send({ type: 'license_state', license: currentLicenseStatus() })
}

/**
 * Actively sync the license term: run one heartbeat now (PL-R7), then push the
 * refreshed {@link currentLicenseStatus} followed by a `license_refresh_result`
 * ack. Lets a console renewal surface immediately instead of waiting for the
 * next scheduled beat. Heartbeat is fail-soft (PL-R13) — it never throws, so a
 * network / LS 5xx failure resolves to `ok:false` with the outcome reason; the
 * cached term is left untouched. Reuses {@link runHeartbeatOnce}; no new sync
 * path, scheduler/interval unchanged.
 */
export const refreshLicense: Handler<'refresh_license'> = async (_ctx, conn) => {
  const outcome = await runHeartbeatOnce()
  // Always reflect the latest cache (a successful beat refreshed the term).
  conn.send({ type: 'license_state', license: currentLicenseStatus() })
  const ok = outcome.status !== 'error'
  conn.send({
    type: 'license_refresh_result',
    ok,
    reason: ok || !('reason' in outcome) ? undefined : outcome.reason,
  })
}

/**
 * Open the LS landing page in the browser so the user can log in with GitHub and
 * bind a license (PL-R1/PL-R9), and start polling `checkbind` for this round. We
 * acknowledge with the URL so the console can offer it as a manual fallback; the
 * completed (or failed) bind is pushed later via the activation result sink.
 */
export const startLicenseActivation: Handler<'start_license_activation'> = (_ctx, conn) => {
  try {
    const { activationUrl } = startActivation()
    conn.send({ type: 'license_activation_started', ok: true, activationUrl })
  } catch (e) {
    conn.send({ type: 'license_activation_started', ok: false, reason: (e as Error).message })
  }
}
