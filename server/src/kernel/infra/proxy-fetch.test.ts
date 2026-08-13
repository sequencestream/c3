import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createProxyFetch, matchesNoProxy, resolveProxyUrl } from './proxy-fetch.js'

const OFF = { enabled: false, httpProxy: '', httpsProxy: '' }
const ON = { enabled: true, httpProxy: 'http://cfg:3128', httpsProxy: 'http://cfgs:3129' }

describe('matchesNoProxy', () => {
  it('matches exact hosts, subdomains and the wildcard', () => {
    expect(matchesNoProxy(new URL('https://example.com/x'), 'example.com')).toBe(true)
    expect(matchesNoProxy(new URL('https://api.example.com/x'), '.example.com')).toBe(true)
    expect(matchesNoProxy(new URL('https://example.com/x'), '*')).toBe(true)
    expect(matchesNoProxy(new URL('https://notexample.com/x'), 'example.com')).toBe(false)
    expect(matchesNoProxy(new URL('https://example.com/x'), '')).toBe(false)
  })

  it('honors a port pin on the entry', () => {
    expect(matchesNoProxy(new URL('http://example.com:8080/'), 'example.com:8080')).toBe(true)
    expect(matchesNoProxy(new URL('http://example.com:9090/'), 'example.com:8080')).toBe(false)
    expect(matchesNoProxy(new URL('https://example.com/'), 'example.com:443')).toBe(true)
  })
})

describe('resolveProxyUrl', () => {
  const target = new URL('https://github.com/sequencestream/c3/releases/latest')

  it('never proxies loopback', () => {
    expect(resolveProxyUrl(new URL('http://127.0.0.1:3000/x'), ON, {})).toBeNull()
    expect(resolveProxyUrl(new URL('http://localhost:3000/x'), ON, {})).toBeNull()
  })

  it('prefers the configured proxy over the environment', () => {
    expect(resolveProxyUrl(target, ON, { HTTPS_PROXY: 'http://env:8080' })).toBe(
      'http://cfgs:3129/',
    )
  })

  it('falls back to the environment when the setting is disabled', () => {
    expect(resolveProxyUrl(target, OFF, { HTTPS_PROXY: 'http://env:8080' })).toBe(
      'http://env:8080/',
    )
    expect(resolveProxyUrl(target, OFF, {})).toBeNull()
  })

  it('uses the http proxy for an https target when no https proxy is set', () => {
    const httpOnly = { enabled: true, httpProxy: 'http://cfg:3128', httpsProxy: '' }
    expect(resolveProxyUrl(target, httpOnly, {})).toBe('http://cfg:3128/')
  })

  it('respects NO_PROXY from the environment', () => {
    expect(resolveProxyUrl(target, ON, { NO_PROXY: 'github.com' })).toBeNull()
  })

  it('rejects a configured scheme it cannot honor, but ignores one in the env', () => {
    const socks = { enabled: true, httpProxy: '', httpsProxy: 'socks5://host:1080' }
    expect(() => resolveProxyUrl(target, socks, {})).toThrow(/socks5/)
    expect(resolveProxyUrl(target, OFF, { HTTPS_PROXY: 'socks5://host:1080' })).toBeNull()
  })
})

describe('createProxyFetch', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    )
  })

  /** A fake HTTP proxy: answers absolute-form requests itself, never forwards. */
  function startProxy(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    onConnect?: (req: IncomingMessage, socket: Socket) => void,
  ): Promise<string> {
    const server = createServer(handler)
    if (onConnect) server.on('connect', onConnect)
    servers.push(server)
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        resolve(`http://127.0.0.1:${port}`)
      })
    })
  }

  it('passes through to the native fetch when no proxy applies', async () => {
    const calls: unknown[] = []
    const baseFetch = (async (input: unknown, init: unknown) => {
      calls.push([input, init])
      return new Response('direct')
    }) as unknown as typeof fetch
    const doFetch = createProxyFetch({ proxySettings: () => OFF, env: {}, baseFetch })

    const res = await doFetch('https://github.com/x', { redirect: 'manual' })

    expect(await res.text()).toBe('direct')
    expect(calls).toEqual([['https://github.com/x', { redirect: 'manual' }]])
  })

  it('hands the proxy to the native fetch under Bun', async () => {
    let seen: RequestInit | undefined
    const baseFetch = (async (_input: unknown, init: RequestInit) => {
      seen = init
      return new Response('bun')
    }) as unknown as typeof fetch
    const doFetch = createProxyFetch({
      proxySettings: () => ON,
      env: {},
      baseFetch,
      isBun: true,
    })

    await doFetch('https://github.com/x')

    expect((seen as { proxy?: string } | undefined)?.proxy).toBe('http://cfgs:3129/')
  })

  it('sends an http target to the proxy in absolute form, with credentials', async () => {
    const seen: { url?: string; auth?: string; ua?: string } = {}
    const base = await startProxy((req, res) => {
      seen.url = req.url ?? ''
      seen.auth = req.headers['proxy-authorization'] as string | undefined
      seen.ua = req.headers['user-agent'] as string | undefined
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('through the proxy')
    })
    const withCreds = base.replace('http://', 'http://user:p%40ss@')
    const doFetch = createProxyFetch({
      proxySettings: () => ({ enabled: true, httpProxy: withCreds, httpsProxy: '' }),
      env: {},
      isBun: false,
    })

    const res = await doFetch('http://example.invalid/releases/latest', {
      headers: { 'User-Agent': 'c3-upgrade' },
    })

    expect(await res.text()).toBe('through the proxy')
    expect(seen.url).toBe('http://example.invalid/releases/latest')
    expect(seen.ua).toBe('c3-upgrade')
    expect(seen.auth).toBe(`Basic ${Buffer.from('user:p@ss').toString('base64')}`)
  })

  it('returns a 3xx untouched under redirect: manual (the release-tag path)', async () => {
    const proxy = await startProxy((_req, res) => {
      res.writeHead(302, { location: 'https://github.com/o/r/releases/tag/v9.9.9' })
      res.end()
    })
    const doFetch = createProxyFetch({
      proxySettings: () => ({ enabled: true, httpProxy: proxy, httpsProxy: '' }),
      env: {},
      isBun: false,
    })

    const res = await doFetch('http://github.invalid/o/r/releases/latest', { redirect: 'manual' })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://github.com/o/r/releases/tag/v9.9.9')
  })

  it('follows redirects and drops credentials when the origin changes', async () => {
    const hops: { url: string; auth?: string }[] = []
    const proxy = await startProxy((req, res) => {
      hops.push({ url: req.url ?? '', auth: req.headers.authorization as string | undefined })
      if (hops.length === 1) {
        res.writeHead(302, { location: 'http://cdn.invalid/package.tar.gz' })
        res.end()
        return
      }
      res.writeHead(200)
      res.end('payload')
    })
    const doFetch = createProxyFetch({
      proxySettings: () => ({ enabled: true, httpProxy: proxy, httpsProxy: '' }),
      env: {},
      isBun: false,
    })

    const res = await doFetch('http://releases.invalid/download', {
      headers: { Authorization: 'Bearer secret' },
    })

    expect(await res.text()).toBe('payload')
    expect(hops.map((h) => h.url)).toEqual([
      'http://releases.invalid/download',
      'http://cdn.invalid/package.tar.gz',
    ])
    expect(hops[0].auth).toBe('Bearer secret')
    expect(hops[1].auth).toBeUndefined()
  })

  it('surfaces a refused CONNECT rather than falling back to a direct connection', async () => {
    const proxy = await startProxy(
      (_req, res) => {
        res.writeHead(200)
        res.end()
      },
      (_req, socket) => {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      },
    )
    const doFetch = createProxyFetch({
      proxySettings: () => ({ enabled: true, httpProxy: '', httpsProxy: proxy }),
      env: {},
      isBun: false,
    })

    await expect(doFetch('https://github.com/o/r/releases/latest')).rejects.toThrow(
      /refused CONNECT github\.com:443: HTTP 403/,
    )
  })
})
