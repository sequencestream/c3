/**
 * `license` feature handlers (ADR-0026 product-license). Three read/drive
 * actions: fetch the current entitlement state for the badge/menu, open the LS
 * sign-in page to obtain a license key, and bind this installation to a key.
 * The heartbeat scheduler lives in `heartbeat.ts` (started at server boot).
 * Handlers are `(ctx, conn, msg)` (ADR-0009).
 */
import type { Handler } from '../../transport/handler-registry.js'
import { bindLicense, startActivation } from './activation.js'
import { currentLicenseStatus } from './store.js'

/** Reply with the current license state (drives the badge/menu, PL-R7). */
export const getLicense: Handler<'get_license'> = (_ctx, conn) => {
  conn.send({ type: 'license_state', license: currentLicenseStatus() })
}

/**
 * Open the LS sign-in page in the browser so the user can log in with GitHub and
 * obtain a license key (PL-R1/PL-R9). GitHub is account login/registration only.
 * We acknowledge with the URL so the console can offer it as a manual fallback;
 * the user then activates with {@link bindLicenseHandler} (bind_license).
 */
export const startLicenseActivation: Handler<'start_license_activation'> = (_ctx, conn) => {
  try {
    const { activationUrl } = startActivation()
    conn.send({ type: 'license_activation_started', ok: true, activationUrl })
  } catch (e) {
    conn.send({ type: 'license_activation_started', ok: false, reason: (e as Error).message })
  }
}

/**
 * Bind this installation to a license by its key (PL-R1). On success the verified
 * entitlement is cached and the refreshed state is pushed back to the caller
 * (PL-R7). Fail-soft: a failure replies `ok:false` with a reason and never throws
 * into the connection (PL-R13).
 */
export const bindLicenseHandler: Handler<'bind_license'> = async (_ctx, conn, msg) => {
  const outcome = await bindLicense({ licenseKey: msg.licenseKey })
  if (outcome.ok) {
    conn.send({ type: 'license_bind_result', ok: true })
    conn.send({ type: 'license_state', license: currentLicenseStatus() })
  } else {
    conn.send({ type: 'license_bind_result', ok: false, reason: outcome.reason })
  }
}
