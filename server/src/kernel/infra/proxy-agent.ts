/**
 * An `https.Agent` that reaches its target through an HTTP CONNECT proxy.
 *
 * `proxy-fetch.ts` already tunnels c3's outbound HTTP this way, but a WebSocket
 * client cannot be handed a `fetch` — it needs an agent. This module supplies
 * that shape while reusing the same proxy resolution (`resolveProxyUrl`), so
 * both paths honour one configuration: settings first, then the standard
 * environment variables, with loopback and `NO_PROXY` exempt.
 *
 * Returning `null` for "no proxy applies" is deliberate — the caller then passes
 * no agent at all and gets Node's default behaviour, rather than a pass-through
 * agent that would have to reimplement it.
 */
import { Agent as HttpsAgent, type AgentOptions } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { RequestOptions } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import type { Socket } from 'node:net'
import { PassThrough, type Duplex } from 'node:stream'
import { resolveProxyUrl, type ProxySettingsView } from './proxy-fetch.js'

/**
 * A stream that exists only to satisfy the callback's shape on the failure path.
 * Node reads the error first and never touches the stream, but the signature
 * requires one.
 */
function discarded(): Duplex {
  return new PassThrough().destroy()
}

/**
 * Opens a CONNECT tunnel to the proxy, then completes the TLS handshake with the
 * ORIGIN inside it — so the proxy sees only the host name, never the traffic.
 */
class ProxyTunnelAgent extends HttpsAgent {
  constructor(
    private readonly proxy: URL,
    options?: AgentOptions,
  ) {
    super(options)
  }

  createConnection(
    options: RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const host = options.host ?? ''
    const port = Number(options.port ?? 443)
    const headers: Record<string, string> = { Host: `${host}:${port}` }
    if (this.proxy.username || this.proxy.password) {
      const raw = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(raw).toString('base64')}`
    }

    const req = httpRequest({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
    })

    req.once('connect', (res, socket: Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        callback?.(new Error(`proxy CONNECT failed with status ${res.statusCode}`), discarded())
        return
      }
      callback?.(null, tlsConnect({ socket, servername: host }))
    })
    req.once('error', (err) => callback?.(err, discarded()))
    req.end()
    // The socket arrives through the callback once the tunnel is open, so there
    // is nothing to return synchronously.
    return undefined
  }
}

/**
 * An agent for reaching `targetUrl`, or null when no proxy applies to it.
 *
 * `settings` and `env` are injected so this stays testable without touching the
 * real configuration or process environment.
 */
export function proxyAgentFor(
  targetUrl: string,
  settings: ProxySettingsView,
  env: NodeJS.ProcessEnv = process.env,
): HttpsAgent | null {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return null
  }
  // A WebSocket URL carries the same proxy semantics as the HTTP(S) it upgrades
  // from, so it is resolved as that scheme.
  const asHttp = new URL(target.href)
  if (asHttp.protocol === 'wss:') asHttp.protocol = 'https:'
  else if (asHttp.protocol === 'ws:') asHttp.protocol = 'http:'

  let proxyUrl: string | null
  try {
    proxyUrl = resolveProxyUrl(asHttp, settings, env)
  } catch {
    // A malformed configured proxy is reported by the fetch path; here it just
    // means "no usable agent", and the connection attempt proceeds directly.
    return null
  }
  if (!proxyUrl) return null

  try {
    return new ProxyTunnelAgent(new URL(proxyUrl), { keepAlive: true })
  } catch {
    return null
  }
}
