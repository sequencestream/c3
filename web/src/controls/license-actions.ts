/**
 * App controller — product-license actions (ADR-0026). Opens the LS sign-in
 * page for license activation. State (`license`, `licenseActivationUrl`) is
 * fetched/pushed by the server and folded in by the message handler; this only
 * sends the request.
 */
import type { AppCtx } from './types'

export function installLicenseActions(ctx: AppCtx): void {
  ctx.activateLicense = (): void => {
    // Clear any stale fallback URL; a fresh `license_activation_started` follows.
    ctx.licenseActivationUrl.value = null
    ctx.send({ type: 'start_license_activation' })
  }

  // Actively sync the license term now (PL-R7): the server runs one heartbeat
  // and pushes a refreshed `license_state` + a `license_refresh_result` ack.
  // Flag the round-trip as in-flight (disables the control) and clear any prior
  // error; the handler folds the result back in. In-flight guards against a
  // double-send; the per-control min-cooldown lives in the component.
  ctx.refreshLicense = (): void => {
    if (ctx.licenseRefreshing.value) return
    ctx.licenseRefreshError.value = null
    ctx.licenseRefreshing.value = true
    ctx.send({ type: 'refresh_license' })
  }
}
