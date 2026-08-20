/**
 * The Feishu provider: the only place in c3 that knows what Feishu is.
 *
 * It uses the platform SDK for the INBOUND long link alone — `WSClient` holds
 * the connection, keeps it alive, reconnects, and decodes Feishu's private
 * binary frames, which is the part that would be unreasonable to reimplement.
 * Everything c3 SENDS goes through `api.ts` on c3's own outbound channel
 * (ADR-0046).
 *
 * Nothing platform-neutral lives here. Whether an @-mention is required, whether
 * a repeat delivery should be dropped, how many turns may run at once, how a
 * long reply is split — all of that belongs to the supervisor above, so the
 * second platform inherits it instead of reimplementing it.
 *
 * The SDK import is confined to this directory by design: it is the seam, and
 * keeping it here is what lets the rest of the codebase stay unaware of Feishu.
 */
import {
  EventDispatcher,
  WSClient,
  LoggerLevel,
  defaultHttpInstance,
} from '@larksuiteoapi/node-sdk'
import type { ImConnectionStatus } from '@ccc/shared/protocol'
import { getProxyConfig } from '../../../../kernel/config/index.js'
import { proxyAgentFor } from '../../../../kernel/infra/proxy-agent.js'
import type {
  ImConnectInput,
  ImConnection,
  ImProvider,
  ImProviderCapabilities,
} from '../../types.js'
import { FeishuApi } from './api.js'
import { normalizeFeishuMessage } from './normalize.js'

/**
 * The host the long link is established against. Used only to decide whether a
 * proxy applies — the SDK discovers the actual endpoint itself.
 */
const FEISHU_WS_ORIGIN = 'wss://open.feishu.cn'

// The SDK's HTTP client otherwise picks a proxy out of `http_proxy` / `all_proxy`
// on its own, and the long link then fails with a protocol mismatch even when an
// agent was supplied — a machine with those variables exported (common) could
// never connect. c3 decides the proxy itself and passes it as an agent below, so
// the client's own detection is turned off once, here.
defaultHttpInstance.defaults.proxy = false

const CAPABILITIES: ImProviderCapabilities = {
  outboundLongPoll: true,
  // Feishu has native topics, though it only sets the topic id inside one.
  threads: true,
  // The SDK acknowledges frames and suppresses obvious repeats, but a reconnect
  // can still redeliver, so the neutral layer keeps its own guard.
  inboundDedup: false,
  maxOutboundChars: 4000,
}

/** Bridge the SDK's logger shape onto c3's console conventions. */
const logger = {
  error: (...args: unknown[]): void => console.error('[c3][feishu]', ...args),
  warn: (...args: unknown[]): void => console.warn('[c3][feishu]', ...args),
  info: (): void => {},
  debug: (): void => {},
  trace: (): void => {},
}

export function createFeishuProvider(): ImProvider {
  return {
    platform: 'feishu',
    capabilities: CAPABILITIES,

    async connect(input: ImConnectInput): Promise<ImConnection> {
      const api = new FeishuApi(input.appId, input.appSecret)
      // Resolved once per connection: without the bot's own id there is no way to
      // tell "this robot was mentioned" from "somebody was mentioned", and the
      // require-mention policy would be unenforceable.
      const botOpenId = await api.botOpenId()

      const dispatcher = new EventDispatcher({}).register({
        'im.message.receive_v1': (data) => {
          const message = normalizeFeishuMessage(data, botOpenId)
          // Everything the robot cannot act on (non-text, other bots, empty
          // bodies) is dropped here rather than travelling further as a null.
          if (message) input.onMessage(message)
        },
      })

      const agent = proxyAgentFor(FEISHU_WS_ORIGIN, getProxyConfig())
      const ws = new WSClient({
        appId: input.appId,
        appSecret: input.appSecret,
        loggerLevel: LoggerLevel.warn,
        logger,
        autoReconnect: true,
        ...(agent ? { agent } : {}),
      })

      const report = (): void => input.onStateChange?.(status())
      const status = (): ImConnectionStatus => {
        const snapshot = ws.getConnectionStatus()
        return {
          state: snapshot?.state ?? 'idle',
          reconnectAttempts: snapshot?.reconnectAttempts ?? 0,
        }
      }

      await ws.start({ eventDispatcher: dispatcher })
      report()

      return {
        status,
        async send(chatId, out) {
          const messageId = await api.sendText(chatId, out.text, out.replyTo)
          return { messageId }
        },
        close(): Promise<void> {
          ws.close({ force: true })
          report()
          return Promise.resolve()
        },
      }
    },
  }
}
