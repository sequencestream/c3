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
import { EventDispatcher, WSClient, LoggerLevel } from '@larksuiteoapi/node-sdk'
import type { ImConnectionStatus } from '@ccc/shared/protocol'
import { getProxyConfig } from '../../../../kernel/config/index.js'
import { proxyAgentFor } from '../../../../kernel/infra/proxy-agent.js'
import type {
  ImConnectInput,
  ImConnection,
  ImProvider,
  ImProviderCapabilities,
} from '../../types.js'
import { logImProviderSkip } from '../../im-log.js'
import { FeishuApi } from './api.js'
import { parseFeishuInbound } from './normalize.js'
import { installSdkHttpAgent } from './sdk-http.js'

/**
 * The host the long link is established against. Used only to decide whether a
 * proxy applies — the SDK discovers the actual endpoint itself.
 */
const FEISHU_WS_ORIGIN = 'wss://open.feishu.cn'

/** How long to wait for the first successful WS handshake after `start()`. */
const CONNECT_READY_TIMEOUT_MS = 45_000

// The SDK's HTTP client otherwise picks a proxy out of `http_proxy` / `all_proxy`
// on its own, and the long link then fails with a protocol mismatch even when an
// agent was supplied — a machine with those variables exported (common) could
// never connect. c3 decides the proxy itself: the shared initializer kills
// axios' own detection once and re-applies c3's per-request agent decision for
// the SDK's Device Authorization calls; the long link below passes its agent
// explicitly and never goes through that interceptor.
installSdkHttpAgent()

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
  // Connection lifecycle (ws ready, reconnect, unknown event types) helps diagnose silent bots.
  info: (...args: unknown[]): void => console.info('[c3][feishu]', ...args),
  debug: (): void => {},
  trace: (): void => {},
}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200)
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
      console.info(
        `[c3][feishu] bot open_id ${botOpenId ? 'resolved' : 'missing'} robotId=${input.robotId}`,
      )

      // Share c3's logger so "no <type> handle" / verification warnings are visible.
      const dispatcher = new EventDispatcher({
        loggerLevel: LoggerLevel.info,
        logger,
      }).register({
        'im.message.receive_v1': (data) => {
          console.info(`[c3][feishu] event im.message.receive_v1 robotId=${input.robotId}`)
          const parsed = parseFeishuInbound(data, botOpenId)
          // Everything the robot cannot act on (non-text, other bots, empty
          // bodies) is dropped here rather than travelling further as a null.
          if (!parsed.ok) {
            logImProviderSkip({
              robotId: input.robotId,
              reason: parsed.reason,
              messageType: parsed.messageType,
              chatType: parsed.chatType,
            })
            return
          }
          input.onMessage(parsed.message)
        },
      })

      const agent = proxyAgentFor(FEISHU_WS_ORIGIN, getProxyConfig())

      // `WSClient.start()` returns before the socket is open — it only kicks off
      // reconnect. Gate on onReady / terminal onError so "connected" means events
      // can arrive.
      let resolveReady!: () => void
      let rejectReady!: (err: Error) => void
      let settled = false
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        settle(() =>
          rejectReady(
            new Error(
              `feishu ws not ready within ${CONNECT_READY_TIMEOUT_MS}ms ` +
                '(Developer Console → 事件与回调 → 订阅方式 must be 长连接; ' +
                'also subscribe im.message.receive_v1; check network/proxy)',
            ),
          ),
        )
      }, CONNECT_READY_TIMEOUT_MS)
      timer.unref?.()

      const wsRef: { current: WSClient | null } = { current: null }
      const report = (): void => input.onStateChange?.(status())
      const status = (): ImConnectionStatus => {
        const snapshot = wsRef.current?.getConnectionStatus()
        return {
          state: snapshot?.state ?? 'idle',
          reconnectAttempts: snapshot?.reconnectAttempts ?? 0,
        }
      }

      const ws = new WSClient({
        appId: input.appId,
        appSecret: input.appSecret,
        // info: surface SDK "ws client ready" / long-connection setup hints.
        loggerLevel: LoggerLevel.info,
        logger,
        autoReconnect: true,
        onReady: () => {
          console.info('[c3][feishu] ws ready')
          report()
          settle(resolveReady)
        },
        onError: (e: Error) => {
          console.error('[c3][feishu] ws terminal error:', errMsg(e))
          report()
          settle(() => rejectReady(e instanceof Error ? e : new Error(errMsg(e))))
        },
        onReconnecting: () => {
          console.warn('[c3][feishu] ws reconnecting')
          report()
        },
        onReconnected: () => {
          console.info('[c3][feishu] ws reconnected')
          report()
        },
        ...(agent ? { agent } : {}),
      })
      wsRef.current = ws

      await ws.start({ eventDispatcher: dispatcher })
      report()
      await ready

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
