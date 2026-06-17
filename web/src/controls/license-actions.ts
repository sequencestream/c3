/**
 * App controller — product-license actions (ADR-0026). Installs two drive
 * actions: open the LS sign-in page to obtain a license key, and bind a pasted
 * key to this installation. State (`license`, `licenseActivationUrl`) is
 * fetched/pushed by the server and folded in by the message handler; these only
 * send the requests. The badge/menu reads the state and calls these on user
 * action.
 */
import type { AppCtx } from './types'

export function installLicenseActions(ctx: AppCtx): void {
  ctx.activateLicense = (): void => {
    // Clear any stale fallback URL; a fresh `license_activation_started` follows.
    ctx.licenseActivationUrl.value = null
    ctx.send({ type: 'start_license_activation' })
  }

  ctx.bindLicense = (licenseKey: string): void => {
    const key = licenseKey.trim()
    if (!key) return
    ctx.send({ type: 'bind_license', licenseKey: key })
  }
}
