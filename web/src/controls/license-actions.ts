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
}
