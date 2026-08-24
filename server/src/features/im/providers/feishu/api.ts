/**
 * Feishu's outbound half, implemented here rather than taken from the SDK.
 *
 * ADR-0046 draws the line: the platform SDK supplies the inbound long link —
 * the part that is genuinely hard to reimplement, being a private binary
 * protocol — while everything c3 SENDS goes through c3's own outbound HTTP
 * channel. Two reasons, one of them load-bearing:
 *
 *  - Outbound is the thing being regulated. Keeping every byte c3 sends inside
 *    c3's own code is what leaves the content guard and the audit with no path
 *    around them.
 *  - `outboundFetch` is already the server's single egress, with proxy and
 *    NO_PROXY handling settled. A second HTTP client would have to be taught the
 *    same things and then verified separately.
 *
 * The tenant access token is short-lived, so it is cached and refreshed a little
 * before it expires rather than fetched per message.
 */
import type { AppRegistrationManualSetupReason } from '@ccc/shared/protocol'
import { outboundFetch } from '../../../../kernel/infra/proxy-fetch.js'

const FEISHU_BASE = 'https://open.feishu.cn/open-apis'

/** Refresh this long before the stated expiry, so a call never races it. */
const TOKEN_EARLY_REFRESH_MS = 60_000

export class FeishuApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'FeishuApiError'
  }
}

interface TokenResponse {
  code: number
  msg: string
  tenant_access_token?: string
  expire?: number
}

interface BotInfoResponse {
  code: number
  msg: string
  bot?: { open_id?: string; app_name?: string }
}

interface SendResponse {
  code: number
  msg: string
  data?: { message_id?: string }
}

interface ApplicationConfigResponse {
  code: number
  msg: string
}

/** Single timeout for the token + v7 config PATCH leg of one-click setup. */
const APP_CONFIG_TIMEOUT_MS = 15_000

/**
 * Holds one app's credentials and its cached token. One instance per robot —
 * the token is per app, and sharing one across robots would couple their
 * lifetimes for no gain.
 */
export class FeishuApi {
  private token: string | null = null
  private tokenExpiresAt = 0
  /** In-flight refresh, so concurrent sends do not each fetch a token. */
  private refreshing: Promise<string> | null = null

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  private async fetchToken(signal?: AbortSignal): Promise<string> {
    const res = await outboundFetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal,
    })
    const body = (await res.json()) as TokenResponse
    if (body.code !== 0 || !body.tenant_access_token) {
      // The message is Feishu's; it describes the app, never the secret.
      throw new FeishuApiError(body.code, `tenant_access_token failed: ${body.msg}`)
    }
    this.token = body.tenant_access_token
    this.tokenExpiresAt = Date.now() + (body.expire ?? 0) * 1000
    return this.token
  }

  /**
   * A currently valid token, refreshing it when it is missing or near expiry.
   * `signal` only matters for the refresh leg it triggers here; a caller that
   * joins an already in-flight refresh started by another caller does not
   * abort it early just because its own signal fires.
   */
  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_EARLY_REFRESH_MS) {
      return this.token
    }
    if (!this.refreshing) {
      this.refreshing = this.fetchToken(signal).finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async authorizedPost<T>(path: string, payload: unknown): Promise<T> {
    const res = await outboundFetch(`${FEISHU_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${await this.accessToken()}`,
      },
      body: JSON.stringify(payload),
    })
    return (await res.json()) as T
  }

  /**
   * The bot's own open id, needed to tell "this robot was mentioned" from
   * "somebody was mentioned". Fetched once per connection.
   */
  async botOpenId(): Promise<string | null> {
    const res = await outboundFetch(`${FEISHU_BASE}/bot/v3/info`, {
      headers: { Authorization: `Bearer ${await this.accessToken()}` },
    })
    const body = (await res.json()) as BotInfoResponse
    if (body.code !== 0 || !body.bot?.open_id) {
      // Losing this is not fatal, but it silently disables the require-mention
      // policy: without the bot's own id nothing can be recognised as mentioning
      // it, so the robot would appear to ignore every message. Say why — the
      // usual cause is an app with no bot capability enabled (code 11205).
      console.warn(
        `[c3][feishu] cannot resolve the bot identity (code ${body.code}: ${body.msg}). ` +
          'Mention-based replies will not work until the app has bot capability enabled.',
      )
      return null
    }
    return body.bot.open_id
  }

  /**
   * Send a text message. When `replyTo` is set the message is posted as a reply
   * so it lands next to the question it answers; Feishu threads replies itself.
   */
  async sendText(chatId: string, text: string, replyTo?: string): Promise<string> {
    const content = JSON.stringify({ text })
    const body = replyTo
      ? await this.authorizedPost<SendResponse>(
          `/im/v1/messages/${encodeURIComponent(replyTo)}/reply`,
          { msg_type: 'text', content },
        )
      : await this.authorizedPost<SendResponse>('/im/v1/messages?receive_id_type=chat_id', {
          receive_id: chatId,
          msg_type: 'text',
          content,
        })
    if (body.code !== 0) {
      throw new FeishuApiError(body.code, `send failed: ${body.msg}`)
    }
    return body.data?.message_id ?? ''
  }
}

/**
 * Outcome of the post-registration long-connection configuration.
 * `configured` is the only success; every other value is a closed reason the
 * caller surfaces as `manual_setup_required` together with the credentials.
 */
export type AppConfigOutcome = 'configured' | AppRegistrationManualSetupReason

/**
 * Configure a just-created Feishu app for c3's inbound long connection, using
 * application v7's `applicationConfig.patch` with the app's OWN tenant token.
 *
 * The path and payload are deliberate:
 *  - `PATCH /open-apis/application/v7/applications/{appId}/config` — the v7
 *    development-config endpoint; NOT the v6 "update app group info" PATCH,
 *    which shares no model with dev config (and would need a `lang` query).
 *  - body carries only `event.subscription_type='websocket'` and
 *    `event.add_events=['im.message.receive_v1']`.
 *  - no SDK `Client` is constructed; the token and the PATCH both ride c3's
 *    own `outboundFetch` channel, so proxy/NO_PROXY handling is the settled one.
 *
 * `code=0` is the only synchronous "accepted by the official config interface"
 * signal. HTTP 404/405/501 (interface unavailable), 403 (permission denied),
 * non-zero business code and network/timeout failures map to the four closed
 * `manual_setup_required` reasons so the created app stays findable.
 */
export async function configureAppWebsocket(
  appId: string,
  appSecret: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AppConfigOutcome> {
  if (!appId || !appSecret) {
    throw new FeishuApiError(0, 'configureAppWebsocket requires both credentials')
  }
  const timeoutMs = opts.timeoutMs ?? APP_CONFIG_TIMEOUT_MS
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  try {
    const api = new FeishuApi(appId, appSecret)
    const token = await api.accessToken(signal)
    const res = await outboundFetch(
      `${FEISHU_BASE}/application/v7/applications/${encodeURIComponent(appId)}/config`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          event: {
            subscription_type: 'websocket',
            add_events: ['im.message.receive_v1'],
          },
        }),
        signal,
      },
    )
    if (res.status === 403) return 'config_forbidden'
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return 'config_unavailable'
    }
    const body = (await res.json()) as ApplicationConfigResponse
    if (body.code === 0) return 'configured'
    return 'config_rejected'
  } catch (err) {
    // Caller cancellation (e.g. the form closed mid-config) and network faults
    // both land here; after credentials exist the app was already created, so
    // the correct result is still a findable manual_setup_required.
    if (err instanceof FeishuApiError) return 'config_rejected'
    return 'config_network_error'
  }
}
