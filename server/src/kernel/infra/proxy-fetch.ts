/**
 * Proxy-aware outbound fetch for the server's OWN HTTP requests.
 *
 * The system-settings `proxy` block was born as a *subprocess* concern: c3 injects
 * `HTTP(S)_PROXY` into every vendor CLI it spawns. But the requests c3 makes on its
 * own behalf — the update check and the self-update download — leave from the server
 * process, and on Node those bypass the proxy entirely: the global `fetch` (undici)
 * ignores `HTTP(S)_PROXY` unless the runtime was started with `--use-env-proxy`,
 * which a service unit installed months ago was not. On a network where GitHub is
 * only reachable through a proxy, the header update hint never appears and the
 * console's "download update" silently fails with a connect error.
 *
 * So this module routes the server's own requests through the SAME proxy the user
 * configured for sessions. Precedence, per request:
 *
 *   1. loopback / `NO_PROXY` match  → direct (c3's own origin is never proxied);
 *   2. the settings `proxy` block, when `enabled`;
 *   3. the host's `HTTPS_PROXY` / `HTTP_PROXY` env vars;
 *   4. otherwise direct — and then the global `fetch` is returned untouched, so the
 *      no-proxy path keeps the runtime's exact native behavior.
 *
 * Transport, when a proxy IS in play:
 *   - under Bun (the compiled binary) the native `fetch` takes a `proxy` option and
 *     does the tunnelling itself;
 *   - under Node we speak the proxy protocol here: `CONNECT` + TLS for https targets,
 *     absolute-form request-target for http ones, following redirects the way the
 *     fetch standard does (auth headers dropped when the origin changes).
 *
 * Only `http://` and `https://` proxies are supported. `socks5://` — which the
 * settings validator accepts, because vendor CLIs may understand it — fails loudly
 * rather than quietly leaking the request straight out to the internet.
 */
import { existsSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { getProxyConfig } from '../config/index.js'
import { dbPath } from './db.js'
import { LOOPBACK_HOSTS } from './no-proxy.js'

/** The settings-shaped proxy decision this module consumes. */
export interface ProxySettingsView {
  enabled: boolean
  httpProxy: string
  httpsProxy: string
}

/** Give up on a proxy that accepts the connection but never answers `CONNECT`. */
const TUNNEL_TIMEOUT_MS = 30_000
/** Redirect budget for the hand-rolled proxy path (the fetch standard uses 20). */
const MAX_REDIRECTS = 20

const DIRECT: ProxySettingsView = { enabled: false, httpProxy: '', httpsProxy: '' }

/**
 * Read the settings proxy block, fail-soft — an unreadable config means "direct"
 * (the environment fallback still applies). A database that does not exist yet is
 * not opened: `c3 upgrade` may run on a host that has never started c3, and asking
 * for the proxy setting must not be what creates its database.
 */
function readProxySettings(): ProxySettingsView {
  try {
    const path = dbPath()
    if (path !== ':memory:' && !existsSync(path)) return DIRECT
    return getProxyConfig()
  } catch {
    return DIRECT
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (LOOPBACK_HOSTS as readonly string[]).includes(host) || host.startsWith('127.')
}

/**
 * `NO_PROXY` matching, in the shape every CLI agrees on: `*` bypasses everything,
 * a leading dot is optional (`.example.com` ≡ `example.com` and matches subdomains),
 * and an entry may pin a port (`example.com:8080`).
 */
export function matchesNoProxy(target: URL, noProxy: string | undefined): boolean {
  const entries = (noProxy ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (entries.length === 0) return false
  if (entries.includes('*')) return true
  const host = target.hostname.toLowerCase()
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')
  for (const raw of entries) {
    let entry = raw.toLowerCase()
    const colon = entry.lastIndexOf(':')
    if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
      if (entry.slice(colon + 1) !== port) continue
      entry = entry.slice(0, colon)
    }
    if (entry.startsWith('.')) entry = entry.slice(1)
    if (!entry) continue
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }
  return false
}

/**
 * Which proxy (if any) this target goes through. Returns null for "connect directly".
 *
 * A configured-but-unsupported scheme throws: the user asked for their traffic to
 * take a specific route, and silently taking a different one is worse than an error
 * the console can show. A junk value in the *environment* only degrades to direct —
 * that variable is the host's business, not something c3 asked for.
 */
export function resolveProxyUrl(
  target: URL,
  settings: ProxySettingsView,
  env: NodeJS.ProcessEnv,
): string | null {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
  if (isLoopbackHost(target.hostname)) return null
  if (matchesNoProxy(target, env.NO_PROXY ?? env.no_proxy)) return null

  const https = target.protocol === 'https:'
  const configured = settings.enabled
    ? https
      ? settings.httpsProxy || settings.httpProxy
      : settings.httpProxy || settings.httpsProxy
    : ''
  const fromEnv = https
    ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy)
  const chosen = (configured || fromEnv || '').trim()
  if (!chosen) return null

  let url: URL
  try {
    url = new URL(chosen)
  } catch {
    if (configured) throw new Error(`configured proxy is not a valid URL: ${chosen}`)
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    if (configured) {
      throw new Error(
        `configured proxy uses ${url.protocol}// — c3's own update check and download ` +
          `support http:// and https:// proxies only`,
      )
    }
    return null // a SOCKS proxy in the environment: the native fetch would ignore it too
  }
  return url.href
}

/** `Proxy-Authorization` for credentials embedded in the proxy URL, if any. */
function proxyAuthHeader(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined
  const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
  return `Basic ${Buffer.from(raw).toString('base64')}`
}

function proxyPort(proxy: URL): number {
  return Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
}

function targetPort(target: URL): string {
  return target.port || (target.protocol === 'https:' ? '443' : '80')
}

/** Open a raw TCP tunnel to `target` through `proxy` via HTTP `CONNECT`. */
async function openTunnel(proxy: URL, target: URL): Promise<Socket> {
  const authority = `${target.hostname}:${targetPort(target)}`
  const headers: Record<string, string> = { host: authority }
  const auth = proxyAuthHeader(proxy)
  if (auth) headers['proxy-authorization'] = auth

  const requestFn = proxy.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise<Socket>((resolve, reject) => {
    const req = requestFn({
      host: proxy.hostname,
      port: proxyPort(proxy),
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
    })
    req.setTimeout(TUNNEL_TIMEOUT_MS, () => {
      req.destroy(new Error(`proxy ${proxy.host} did not answer CONNECT ${authority} in time`))
    })
    req.once('connect', (res: IncomingMessage, socket: Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(
          new Error(`proxy ${proxy.host} refused CONNECT ${authority}: HTTP ${res.statusCode}`),
        )
        return
      }
      socket.setTimeout(0)
      resolve(socket)
    })
    req.once('error', reject)
    req.end()
  })
}

function headerObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/** Turn a Node response into a web `Response`, streaming the body rather than buffering. */
function toResponse(res: IncomingMessage, bodyless: boolean): Response {
  const headers = new Headers()
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const one of value) headers.append(key, one)
    else headers.set(key, value)
  }
  const status = res.statusCode ?? 502
  const init: ResponseInit = { status, statusText: res.statusMessage ?? '', headers }
  // 204/205/304 (and HEAD) must carry a null body or the Response constructor throws.
  if (bodyless || status === 204 || status === 205 || status === 304) {
    res.resume()
    return new Response(null, init)
  }
  return new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, init)
}

type ProxyBody = string | Uint8Array | undefined

/**
 * One request through the proxy — no redirect handling, that is the caller's loop.
 * https targets ride a `CONNECT` tunnel with TLS on top (so the proxy never sees the
 * plaintext); http targets are sent to the proxy in absolute form.
 */
async function requestThroughProxy(
  target: URL,
  proxy: URL,
  method: string,
  headers: Headers,
  body: ProxyBody,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  const path = `${target.pathname}${target.search}`
  const outHeaders = headerObject(headers)
  const auth = proxyAuthHeader(proxy)

  let socket: Socket | undefined
  if (target.protocol === 'https:') socket = await openTunnel(proxy, target)

  return await new Promise<Response>((resolve, reject) => {
    const req =
      target.protocol === 'https:'
        ? httpsRequest({
            host: target.hostname,
            port: Number(targetPort(target)),
            method,
            path,
            headers: outHeaders,
            agent: false,
            // TLS runs on top of the tunnel; `servername` keeps SNI + cert
            // verification pinned to the real target, not to the proxy.
            createConnection: () =>
              tlsConnect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] }),
          })
        : httpRequest({
            host: proxy.hostname,
            port: proxyPort(proxy),
            method,
            path: target.href, // absolute-form request-target, as proxies expect
            headers: auth ? { ...outHeaders, 'proxy-authorization': auth } : outHeaders,
            agent: false,
          })

    const onAbort = (): void => {
      req.destroy(new Error('request aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    req.once('response', (res: IncomingMessage) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(toResponse(res, method === 'HEAD'))
    })
    req.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      socket?.destroy()
      reject(err)
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** The runtime's own fetch signature — `RequestInfo`/`BodyInit` are DOM-only names. */
type FetchInput = Parameters<typeof fetch>[0]
type FetchBody = NonNullable<RequestInit['body']>

function normalizeBody(body: FetchBody | null | undefined): ProxyBody {
  if (body === null || body === undefined) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return body
  throw new TypeError('c3 outbound proxy fetch supports only string or byte bodies')
}

function requestUrlOf(input: FetchInput): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export interface ProxyFetchDeps {
  /** Settings reader; defaults to the live system settings (re-read per request). */
  proxySettings?: () => ProxySettingsView
  env?: NodeJS.ProcessEnv
  /** The runtime's own fetch — used verbatim on the direct path and under Bun. */
  baseFetch?: typeof fetch
  /** Bun's fetch tunnels natively via its `proxy` option; Node needs our transport. */
  isBun?: boolean
}

/**
 * Build a `fetch` that honors the configured proxy. Settings are read per call, so
 * changing the proxy in the console takes effect on the next check/download without
 * a restart. With no proxy in play the runtime's own `fetch` is called unchanged.
 */
export function createProxyFetch(deps: ProxyFetchDeps = {}): typeof fetch {
  const baseFetch = deps.baseFetch ?? fetch
  const isBun = deps.isBun ?? typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const env = deps.env ?? process.env
    const settings = deps.proxySettings ? deps.proxySettings() : readProxySettings()

    let target: URL
    try {
      target = new URL(requestUrlOf(input))
    } catch {
      return await baseFetch(input, init)
    }

    const proxyUrl = resolveProxyUrl(target, settings, env)
    if (!proxyUrl) return await baseFetch(input, init)
    if (isBun) {
      return await baseFetch(input, { ...init, proxy: proxyUrl } as RequestInit)
    }

    const redirect = init?.redirect ?? 'follow'
    const signal = init?.signal
    let method = (init?.method ?? 'GET').toUpperCase()
    let body = normalizeBody(init?.body)
    const headers = new Headers(init?.headers)
    let current = target
    let currentProxy: string | null = proxyUrl

    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new TypeError(`too many redirects for ${target.href}`)

      const res = currentProxy
        ? await requestThroughProxy(current, new URL(currentProxy), method, headers, body, signal)
        : await baseFetch(current.href, { method, headers, body, redirect: 'manual', signal })

      if (redirect === 'manual') return res
      const location = res.headers.get('location')
      if (!isRedirectStatus(res.status) || !location) return res
      if (redirect === 'error') throw new TypeError(`unexpected redirect for ${current.href}`)

      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return res // an unusable Location: hand the redirect back as-is
      }
      // Per the fetch standard: 303 (and 301/302 on POST) degrade to a bodyless GET,
      // and credentials never follow the redirect to a different origin.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        headers.delete('content-length')
        headers.delete('content-type')
      }
      if (next.origin !== current.origin) {
        headers.delete('authorization')
        headers.delete('cookie')
      }
      void res.body?.cancel()
      current = next
      currentProxy = resolveProxyUrl(current, settings, env)
    }
  }
}

/**
 * The server's outbound fetch: use this for requests c3 itself makes to the internet
 * (update check, release download). Session subprocesses get the proxy through their
 * environment instead — see `child-env.ts`.
 */
export const outboundFetch: typeof fetch = createProxyFetch()
