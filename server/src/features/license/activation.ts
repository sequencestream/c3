// c3-side activation: the browser-mediated binding flow (ADR-0026, PL-R1/PL-R9;
// see specs/shared/api-conventions/license-server-api.md §「绑定模型」).
//
// GitHub is account login/registration only. c3 mints a stable `installationId`
// and a per-round `requestId`, then opens the LS website at `/?installId&requestId`
// so the user can sign in with GitHub and **bind a license in the browser**. c3
// does not bind itself — it polls `GET /v1/license/checkbind` over S2S until the
// browser bind completes, then collects the alive token + signed entitlement
// token (never via the browser, PL-R2), verifies the entitlement offline (PL-R5),
// and persists it (0600). Binding is exclusive — one license is live on one
// installation at a time; rebinding elsewhere displaces this one (discovered on
// the next heartbeat).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { getOrCreateInstallationId, saveActivation } from './store.js'
import { verifyEntitlementToken } from './token.js'

/** Default LS origin; overridable for local testing via env. */
export const DEFAULT_LICENSE_SERVER_URL = 'https://c3.sequencestream.com'

/** Resolve the LS base URL (env override lets a local LS be targeted in dev). */
export function licenseServerBaseUrl(): string {
  return process.env.C3_LICENSE_SERVER_URL?.trim() || DEFAULT_LICENSE_SERVER_URL
}

/** Mint a fresh 32-char binding-round id (LS requires exactly 32 chars). */
function makeRequestId(): string {
  return randomUUID().replace(/-/g, '')
}

/**
 * Build the LS landing URL c3 opens the browser to: the SPA root carrying the
 * binding round, so it renders the activation view (and survives the OAuth round,
 * which returns to `/?installId&requestId`).
 */
export function buildSignInUrl(baseUrl: string, installId: string, requestId: string): string {
  const u = new URL('/', baseUrl)
  u.searchParams.set('installId', installId)
  u.searchParams.set('requestId', requestId)
  return u.toString()
}

/** Outcome of an async binding round, surfaced to the console (PL-R7/PL-R13). */
export type ActivationResult = { ok: true } | { ok: false; reason: string }

/** Sink the wiring layer sets so a completed/failed round can push to clients. */
export type ActivationResultSink = (result: ActivationResult) => void

let activationSink: ActivationResultSink | null = null

/** Register (or clear) the sink the binding poll calls when a round resolves. */
export function setActivationResultSink(fn: ActivationResultSink | null): void {
  activationSink = fn
}

export interface StartActivationResult {
  /** The LS landing URL (returned for a manual paste fallback). */
  activationUrl: string
  installationId: string
  requestId: string
}

/**
 * Begin activation: ensure a stable installation id, mint a binding round, open
 * the LS landing page in the browser, and start polling `checkbind` for this
 * round. Binding happens in the browser; c3 cannot know when the user completes
 * it, so the poll runs asynchronously and pushes the result via the sink. Returns
 * the URL so the caller can surface it if the browser could not be opened.
 */
export function startActivation(
  opts: {
    baseUrl?: string
    open?: (url: string) => void
    fetchImpl?: typeof fetch
  } = {},
): StartActivationResult {
  const installationId = getOrCreateInstallationId()
  const requestId = makeRequestId()
  const baseUrl = opts.baseUrl ?? licenseServerBaseUrl()
  const activationUrl = buildSignInUrl(baseUrl, installationId, requestId)
  console.log(
    `[c3:license] activation started install=${installationId} request=${requestId} ls=${baseUrl}`,
  )
  ;(opts.open ?? openBrowser)(activationUrl)
  startCheckbindPolling({
    installId: installationId,
    requestId,
    baseUrl,
    fetchImpl: opts.fetchImpl,
  })
  return { activationUrl, installationId, requestId }
}

// --- checkbind polling -------------------------------------------------------

/** How often to poll checkbind while the user completes the browser bind. */
const CHECKBIND_POLL_INTERVAL_MS = 3000
/** Give up after this long — matches the LS bind-registry TTL (15 min). */
const CHECKBIND_POLL_TIMEOUT_MS = 15 * 60 * 1000

let pollTimer: ReturnType<typeof setTimeout> | undefined
/** Bumped on every (re)start so a stale in-flight tick aborts itself. */
let pollGeneration = 0

interface CheckbindResponse {
  status?: string
  licenseKey?: string
  aliveToken?: string
  entitlementToken?: string
  termEnd?: number
}

/**
 * Poll `checkbind` for one binding round until it completes, fails verification,
 * or times out. Idempotent — a prior round's poll is cancelled first (only the
 * latest activation attempt matters). Fully fail-soft (PL-R13): a transient
 * error keeps polling; only a definitive verification failure or timeout ends it.
 */
export function startCheckbindPolling(opts: {
  installId: string
  requestId: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): void {
  stopCheckbindPolling()
  const generation = ++pollGeneration
  const baseUrl = opts.baseUrl ?? licenseServerBaseUrl()
  const doFetch = opts.fetchImpl ?? fetch
  const deadline = Date.now() + CHECKBIND_POLL_TIMEOUT_MS
  let attempt = 0

  const tick = async (): Promise<void> => {
    if (generation !== pollGeneration) return
    attempt++
    const outcome = await collectBindingOnce({
      installId: opts.installId,
      requestId: opts.requestId,
      baseUrl,
      fetchImpl: doFetch,
    })
    if (generation !== pollGeneration) return
    if (outcome.kind === 'active') {
      console.log(
        `[c3:license] checkbind collected after ${attempt} poll(s) install=${opts.installId} request=${opts.requestId}`,
      )
      activationSink?.({ ok: true })
      return
    }
    if (outcome.kind === 'failed') {
      console.warn(`[c3:license] checkbind failed after ${attempt} poll(s): ${outcome.reason}`)
      activationSink?.({ ok: false, reason: outcome.reason })
      return
    }
    // pending / transient error: keep polling until the round's TTL lapses. A
    // timeout is surfaced (not swallowed) so the console stops showing a spinner
    // forever when the browser bind never lands (PL-R13).
    if (Date.now() >= deadline) {
      console.warn(
        `[c3:license] checkbind timed out after ${attempt} poll(s) install=${opts.installId} request=${opts.requestId}; giving up`,
      )
      activationSink?.({ ok: false, reason: 'timeout' })
      return
    }
    console.log(
      `[c3:license] checkbind pending (poll ${attempt}); retry in ${CHECKBIND_POLL_INTERVAL_MS}ms`,
    )
    pollTimer = setTimeout(() => void tick(), CHECKBIND_POLL_INTERVAL_MS)
    pollTimer.unref?.()
  }
  console.log(
    `[c3:license] checkbind polling started install=${opts.installId} request=${opts.requestId}`,
  )
  pollTimer = setTimeout(() => void tick(), CHECKBIND_POLL_INTERVAL_MS)
  pollTimer.unref?.()
}

/** Stop any in-flight binding poll (called on a new round and on shutdown). */
export function stopCheckbindPolling(): void {
  pollGeneration++
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = undefined
  }
}

type CollectOutcome = { kind: 'active' } | { kind: 'pending' } | { kind: 'failed'; reason: string }

/**
 * Run one checkbind call. On `active`, verify the entitlement offline (PL-R5),
 * confirm it is bound to this installation, and persist it. Returns `pending`
 * (keep polling) for an incomplete round or a transient error; `failed` only for
 * a definitive verification failure. Never throws.
 */
export async function collectBindingOnce(opts: {
  installId: string
  requestId: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  nowSeconds?: number
}): Promise<CollectOutcome> {
  const baseUrl = opts.baseUrl ?? licenseServerBaseUrl()
  const doFetch = opts.fetchImpl ?? fetch

  let resp: Response
  try {
    const url = new URL('/v1/license/checkbind', baseUrl)
    url.searchParams.set('installId', opts.installId)
    url.searchParams.set('requestId', opts.requestId)
    resp = await doFetch(url.toString(), { method: 'GET' })
  } catch (e) {
    console.log(`[c3:license] checkbind network error: ${(e as Error).message}`) // keep polling
    return { kind: 'pending' } // network blip — keep polling
  }
  if (!resp.ok) {
    console.log(`[c3:license] checkbind http ${resp.status}; treating as pending`)
    return { kind: 'pending' } // 503/5xx — transient, keep polling
  }

  let body: CheckbindResponse
  try {
    body = (await resp.json()) as CheckbindResponse
  } catch {
    return { kind: 'pending' }
  }
  if (body.status !== 'active') return { kind: 'pending' }
  if (!body.entitlementToken || !body.aliveToken) {
    return { kind: 'failed', reason: 'incomplete response' }
  }

  // Trust the signature, not the channel (PL-R5): verify offline before caching.
  const verified = verifyEntitlementToken(body.entitlementToken, opts.nowSeconds)
  if (!verified.ok) return { kind: 'failed', reason: `token: ${verified.reason}` }
  if (verified.payload.installationId !== opts.installId) {
    return { kind: 'failed', reason: 'installation mismatch' }
  }

  saveActivation({
    installationId: opts.installId,
    licenseKey: body.licenseKey ?? '',
    entitlementToken: body.entitlementToken,
    aliveToken: body.aliveToken,
    termEnd: body.termEnd ?? verified.payload.termEnd,
  })
  return { kind: 'active' }
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
