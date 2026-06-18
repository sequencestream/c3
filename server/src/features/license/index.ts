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
import { currentLicenseStatus } from './store.js'

/** Reply with the current license state (drives the badge/menu, PL-R7). */
export const getLicense: Handler<'get_license'> = (_ctx, conn) => {
  conn.send({ type: 'license_state', license: currentLicenseStatus() })
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
