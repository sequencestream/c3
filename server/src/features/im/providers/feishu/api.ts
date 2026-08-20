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

  private async fetchToken(): Promise<string> {
    const res = await outboundFetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
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

  /** A currently valid token, refreshing it when it is missing or near expiry. */
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_EARLY_REFRESH_MS) {
      return this.token
    }
    if (!this.refreshing) {
      this.refreshing = this.fetchToken().finally(() => {
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
