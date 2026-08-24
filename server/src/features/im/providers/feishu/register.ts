/**
 * One-click Feishu app registration (Device Authorization).
 *
 * This is the server half of the RobotForm "create Feishu app" entry. It runs
 * the official SDK `registerApp` flow with a FIXED, closed configuration —
 * no client-supplied addons, app id or domain:
 *
 *  - China-only: `domain` is pinned to `accounts.feishu.cn`; a Lark tenant is
 *    refused. The SDK reports a domain switch through `onStatusChange`; the
 *    moment that fires, the task aborts itself so the poll cannot resolve on
 *    the Lark domain, and any credentials that somehow arrive are discarded.
 *  - `createOnly: true`: the scan page hides the "select existing app" entry,
 *    so an existing app can never be re-bound/overwritten by this flow.
 *  - `addons.preset: false`: minimal bot base, exactly the four tenant scopes
 *    and the single `im.message.receive_v1` tenant event — no user scopes,
 *    card callbacks, document/comment/Wiki or file capabilities, and no Agent
 *    manifest. The confirm page is the only observable surface for the addons
 *    gray-scale: the SDK cannot prove whether the platform honoured the
 *    template, so the UI tells the admin to reject the authorization if the
 *    page shows the default template or extra business scopes.
 *
 * After credentials arrive, the task configures the long connection through
 * application v7 and only then reports `ready`; a refused config reports
 * `manual_setup_required` WITH the credentials so the created app stays
 * findable. Every pre-credential failure reports `failed` WITHOUT credentials.
 *
 * Secrets discipline: the authorization URL, device code, app secret and
 * access token never enter logs or generic errors — the task only emits the
 * closed progress/result vocabulary below.
 */
import { registerApp as sdkRegisterApp } from '@larksuiteoapi/node-sdk'
import type {
  AppRegistrationFailedReason,
  AppRegistrationManualSetupReason,
} from '@ccc/shared/protocol'
import { configureAppWebsocket } from './api.js'
import { installSdkHttpAgent } from './sdk-http.js'

// The SDK's Device Authorization begin/poll rides the process-level HTTP
// singleton; make sure the proxy boundary is installed before any call even
// if the long-link provider module was never loaded. Idempotent by design.
installSdkHttpAgent()

/** Feishu China account domain — the only domain this flow runs against. */
export const FEISHU_ACCOUNTS_DOMAIN = 'accounts.feishu.cn'

/** The minimal tenant scope set covering c3's default text bot behaviour. */
export const FEISHU_APP_REGISTRATION_SCOPES = [
  'im:message:send_as_bot',
  'im:message.group_at_msg:readonly',
  'im:message.p2p_msg:readonly',
  'application:bot.basic_info:read',
] as const

/** The only tenant event the minimal template subscribes. */
export const FEISHU_APP_REGISTRATION_EVENTS = ['im.message.receive_v1'] as const

/** Connection-directed progress of one registration attempt. */
export type FeishuRegistrationProgress =
  | { status: 'starting' }
  | { status: 'waiting_scan'; verificationUrl: string; expiresAt: number }
  | { status: 'slow_down' }
  | { status: 'configuring' }

/** Terminal outcome of one registration attempt. */
export type FeishuRegistrationOutcome =
  | { kind: 'ready'; appId: string; appSecret: string }
  | {
      kind: 'manual_setup_required'
      appId: string
      appSecret: string
      reason: AppRegistrationManualSetupReason
    }
  | { kind: 'failed'; reason: AppRegistrationFailedReason; detail?: string }

export interface FeishuRegistrationRunOptions {
  /** The owning task's cancellation signal (manager-owned AbortController). */
  signal: AbortSignal
  /** Abort the owning task — used to kill the poll on a Lark domain switch. */
  abort: () => void
  onProgress: (progress: FeishuRegistrationProgress) => void
  onResult: (outcome: FeishuRegistrationOutcome) => void
  /** Injectable for tests: SDK registerApp replacement. */
  register?: typeof sdkRegisterApp
  /** Injectable for tests: v7 config replacement. */
  configure?: typeof configureAppWebsocket
  now?: () => number
}

/**
 * Run one registration attempt to its terminal outcome. Never throws: every
 * path converges on a closed progress/result vocabulary.
 */
export async function runFeishuAppRegistration(opts: FeishuRegistrationRunOptions): Promise<void> {
  const { signal, abort, onProgress, onResult } = opts
  const register = opts.register ?? sdkRegisterApp
  const configure = opts.configure ?? configureAppWebsocket
  const now = opts.now ?? Date.now
  let domainSwitched = false

  onProgress({ status: 'starting' })
  try {
    const result = await register({
      domain: FEISHU_ACCOUNTS_DOMAIN,
      createOnly: true,
      signal,
      onQRCodeReady: ({ url, expireIn }) => {
        onProgress({
          status: 'waiting_scan',
          verificationUrl: url,
          expiresAt: now() + expireIn * 1000,
        })
      },
      onStatusChange: (info) => {
        if (info.status === 'domain_switched') {
          domainSwitched = true
          // The SDK would keep polling on the Lark domain and could resolve
          // with Lark credentials; aborting makes the flow converge on
          // `unsupported_region` and discards whatever comes next.
          abort()
          return
        }
        if (info.status === 'slow_down') onProgress({ status: 'slow_down' })
      },
      addons: {
        preset: false,
        scopes: { tenant: [...FEISHU_APP_REGISTRATION_SCOPES] },
        events: { items: { tenant: [...FEISHU_APP_REGISTRATION_EVENTS] } },
      },
    })
    // A Lark result that slipped through the abort is still never used — and
    // the flow must still converge on a terminal result, never hang.
    if (domainSwitched) {
      onResult({ kind: 'failed', reason: 'unsupported_region', detail: 'lark tenant detected' })
      return
    }
    if (!result.client_id || !result.client_secret) {
      onResult({
        kind: 'failed',
        reason: 'server_error',
        detail: 'registration completed without full credentials',
      })
      return
    }
    onProgress({ status: 'configuring' })
    const configOutcome = await configure(result.client_id, result.client_secret, { signal })
    if (configOutcome === 'configured') {
      onResult({ kind: 'ready', appId: result.client_id, appSecret: result.client_secret })
      return
    }
    onResult({
      kind: 'manual_setup_required',
      appId: result.client_id,
      appSecret: result.client_secret,
      reason: configOutcome,
    })
  } catch (err) {
    if (domainSwitched) {
      onResult({ kind: 'failed', reason: 'unsupported_region', detail: 'lark tenant detected' })
      return
    }
    if (signal.aborted) {
      onResult({ kind: 'failed', reason: 'cancelled' })
      return
    }
    const code = (err as { code?: unknown }).code
    if (code === 'access_denied') {
      onResult({ kind: 'failed', reason: 'denied' })
    } else if (code === 'expired_token' || code === 'invalid_grant') {
      onResult({ kind: 'failed', reason: 'expired' })
    } else if (typeof code === 'string') {
      onResult({
        kind: 'failed',
        reason: 'server_error',
        detail: 'registration refused by platform',
      })
    } else {
      // Transport failure — no credentials were produced, so no secret can leak.
      onResult({ kind: 'failed', reason: 'network_error' })
    }
  }
}
