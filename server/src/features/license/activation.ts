// c3-side activation: the simplified license-key binding flow (ADR-0026,
// PL-R1/PL-R9).
//
// GitHub is account login/registration only. The user signs in on the LS website
// (opened by `startActivation`), reads the no-refund agreement, and is shown a
// **license key**. They paste that key into c3, which binds this installation to
// it (`bindLicense`): c3 calls the LS bind API with `{ licenseKey, installationId }`,
// verifies the returned signed entitlement token offline (PL-R5), and persists it
// (0600). Binding is exclusive — one license is live on one installation at a
// time; rebinding elsewhere displaces this one (discovered on the next heartbeat).
//
// The alive token returned by the bind is the per-binding heartbeat credential
// (PL-R2) — never the license key, which is a shareable handle, not a bearer.
import { spawn } from 'node:child_process'
import { type LicenseCache, getOrCreateInstallationId, saveActivation } from './store.js'
import { verifyEntitlementToken } from './token.js'

/** Default LS origin; overridable for local testing via env. */
export const DEFAULT_LICENSE_SERVER_URL = 'https://c3.sequencestream.com'

/** Resolve the LS base URL (env override lets a local LS be targeted in dev). */
export function licenseServerBaseUrl(): string {
  return process.env.C3_LICENSE_SERVER_URL?.trim() || DEFAULT_LICENSE_SERVER_URL
}

/** Build the LS sign-in page URL the browser is opened to. */
export function buildSignInUrl(baseUrl: string): string {
  return new URL('/activate', baseUrl).toString()
}

export interface StartActivationResult {
  /** The LS sign-in page URL (returned for a manual paste fallback). */
  activationUrl: string
  installationId: string
}

/**
 * Begin activation: ensure a stable installation id exists and open the LS
 * sign-in page in the browser so the user can log in with GitHub and obtain a
 * license key. Returns the URL so the caller can surface it if the browser could
 * not be opened.
 */
export function startActivation(
  opts: {
    baseUrl?: string
    open?: (url: string) => void
  } = {},
): StartActivationResult {
  const installationId = getOrCreateInstallationId()
  const baseUrl = opts.baseUrl ?? licenseServerBaseUrl()
  const activationUrl = buildSignInUrl(baseUrl)
  ;(opts.open ?? openBrowser)(activationUrl)
  return { activationUrl, installationId }
}

export type BindOutcome = { ok: true; cache: LicenseCache } | { ok: false; reason: string }

/**
 * Bind this installation to a license by its key: call the LS bind API, verify
 * the returned entitlement token offline, and persist it. Pure of browser/timer
 * concerns and fully injectable (fetch, base URL, clock) so it is unit-testable.
 * Fail-soft: every failure returns `{ ok: false }` and never throws (PL-R13).
 */
export async function bindLicense(opts: {
  licenseKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  nowSeconds?: number
}): Promise<BindOutcome> {
  const licenseKey = opts.licenseKey.trim()
  if (!licenseKey) return { ok: false, reason: 'empty license key' }

  const installationId = getOrCreateInstallationId()
  const baseUrl = opts.baseUrl ?? licenseServerBaseUrl()
  const doFetch = opts.fetchImpl ?? fetch

  let resp: Response
  try {
    resp = await doFetch(new URL('/v1/license/bind', baseUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseKey, installationId }),
    })
  } catch (e) {
    return { ok: false, reason: `network: ${(e as Error).message}` }
  }

  if (!resp.ok) {
    let type = `http_${resp.status}`
    try {
      const j = (await resp.json()) as { error?: { type?: string } }
      if (j?.error?.type) type = j.error.type
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, reason: type }
  }

  let body: {
    entitlementToken?: string
    aliveToken?: string
    plan?: string
    termEnd?: number
  }
  try {
    body = (await resp.json()) as typeof body
  } catch {
    return { ok: false, reason: 'malformed response' }
  }
  if (!body.entitlementToken || !body.aliveToken) {
    return { ok: false, reason: 'incomplete response' }
  }

  // Trust the signature, not the channel (PL-R5): verify offline before caching.
  const verified = verifyEntitlementToken(body.entitlementToken, opts.nowSeconds)
  if (!verified.ok) {
    return { ok: false, reason: `token: ${verified.reason}` }
  }
  if (verified.payload.installationId !== installationId) {
    return { ok: false, reason: 'installation mismatch' }
  }

  const cache = saveActivation({
    installationId,
    licenseKey,
    entitlementToken: body.entitlementToken,
    aliveToken: body.aliveToken,
    plan: body.plan ?? verified.payload.plan,
    termEnd: body.termEnd ?? verified.payload.termEnd,
  })
  return { ok: true, cache }
}

/**
 * Open a URL in the user's default browser, cross-platform. Best-effort: a
 * failure is swallowed because the caller also returns the URL for manual use.
 */
function openBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* surfaced via the returned activationUrl */
  }
}
