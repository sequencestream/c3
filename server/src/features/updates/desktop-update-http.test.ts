import { createHash } from 'node:crypto'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_REPO } from '../../upgrade-core.js'
import {
  createDesktopUpdateHttp,
  DESKTOP_UPDATE_CHECK_PATH,
  DESKTOP_UPDATE_DOWNLOAD_PATH,
} from './desktop-update-http.js'

const hex = (data: string) => createHash('sha256').update(data).digest('hex')

interface CheckBody {
  available: boolean
  currentVersion: string
  targetVersion: string | null
  error: string | null
  artifact?: {
    file: string
    kind: string | null
    bytes: number
    sha256: string
    url: string
  } | null
}

const REPO = DEFAULT_REPO
const PKG_BYTES = Buffer.from('the desktop package bytes')
const PKG_SHA = hex(PKG_BYTES.toString())
const PKG_NAME = 'c3-desktop-v0.2.0-macos-arm64.dmg'

const MANIFEST = {
  schema: 'c3-release-manifest/v1.3',
  version: '0.2.0',
  commit: 'abc1234',
  buildTime: '2026-08-05T00:00:00.000Z',
  artifacts: [
    {
      target: 'macos-arm64',
      platform: 'macos',
      arch: 'arm64',
      channel: 'desktop',
      kind: 'dmg',
      preferred: true,
      file: PKG_NAME,
      bytes: PKG_BYTES.length,
      sha256: PKG_SHA,
    },
  ],
}

function makeFetchImpl(opts: { failLatest?: boolean; corruptPkg?: boolean } = {}): typeof fetch {
  const pkgShaLine = `${PKG_SHA}  ${PKG_NAME}`
  const urlToBody = (url: string): Response | null => {
    if (url.includes(`/releases/download/v0.2.0/manifest.json`)) {
      return new Response(JSON.stringify(MANIFEST), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes(`/releases/download/v0.2.0/${PKG_NAME}.sha256`)) {
      return new Response(pkgShaLine, { status: 200 })
    }
    if (url.includes(`/releases/download/v0.2.0/${PKG_NAME}`)) {
      const body = opts.corruptPkg ? Buffer.from('tampered bytes') : PKG_BYTES
      return new Response(body, { status: 200 })
    }
    return null
  }
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = String(input)
    // Primary latest resolution goes through the redirect path.
    if (url.includes('/releases/latest')) {
      if (opts.failLatest) return new Response('boom', { status: 500 })
      return new Response(null, {
        status: 302,
        headers: { location: `https://github.com/${REPO}/releases/tag/v0.2.0` },
      })
    }
    const hit = urlToBody(url)
    if (hit) return hit
    throw new Error(`unexpected URL in test fetch: ${url}`)
  }
}

describe('desktop-update-http', () => {
  let server: ServerType
  let port: number
  let secondServer: ServerType | undefined
  let failingPort = 0

  const http = createDesktopUpdateHttp({ fetchFn: makeFetchImpl() })
  const app = new Hono()
  app.get(DESKTOP_UPDATE_CHECK_PATH, (c) => http.check(c))
  app.get(DESKTOP_UPDATE_DOWNLOAD_PATH, (c) => http.download(c))

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port
        resolve()
      })
    })
  })

  afterAll(() => {
    server?.close()
    secondServer?.close()
  })

  const checkUrl = (qs: string): string =>
    `http://127.0.0.1:${port}${DESKTOP_UPDATE_CHECK_PATH}?${qs}`
  const dlUrl = (qs: string): string =>
    `http://127.0.0.1:${port}${DESKTOP_UPDATE_DOWNLOAD_PATH}?${qs}`

  it('reports an update with the selected desktop artifact', async () => {
    const res = await fetch(checkUrl('current=0.1.0&platform=macos&arch=arm64'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as CheckBody
    expect(body.available).toBe(true)
    expect(body.currentVersion).toBe('0.1.0')
    expect(body.targetVersion).toBe('0.2.0')
    expect(body.error).toBeNull()
    expect(body.artifact).not.toBeNull()
    expect(body.artifact!.file).toBe(PKG_NAME)
    expect(body.artifact!.sha256).toBe(PKG_SHA)
    expect(body.artifact!.bytes).toBe(PKG_BYTES.length)
    expect(body.artifact!.url).toBe(
      `https://github.com/${REPO}/releases/download/v0.2.0/${PKG_NAME}`,
    )
  })

  it('reports up-to-date when the current version is not older', async () => {
    const res = await fetch(checkUrl('current=0.2.0&platform=macos&arch=arm64'))
    const body = (await res.json()) as CheckBody
    expect(body.available).toBe(false)
    expect(body.targetVersion).toBe('0.2.0')
    expect(body.error).toBeNull()
  })

  it('returns a retryable error payload when the latest-version check fails', async () => {
    const failing = createDesktopUpdateHttp({ fetchFn: makeFetchImpl({ failLatest: true }) })
    const failingApp = new Hono()
    failingApp.get(DESKTOP_UPDATE_CHECK_PATH, (c) => failing.check(c))
    await new Promise<void>((resolve) => {
      const s2 = serve({ fetch: failingApp.fetch, port: 0 }, (info) => {
        failingPort = info.port
        resolve()
      })
      secondServer = s2
    })
    const res = await fetch(
      `http://127.0.0.1:${failingPort}${DESKTOP_UPDATE_CHECK_PATH}?current=0.1.0&platform=macos&arch=arm64`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as CheckBody
    expect(body.available).toBe(false)
    expect(body.error).toContain('GitHub release query failed')
  })

  it('streams a package whose .sha256 matches the manifest checksum', async () => {
    const res = await fetch(
      dlUrl(
        `url=${encodeURIComponent(`https://github.com/${REPO}/releases/download/v0.2.0/${PKG_NAME}`)}&bytes=${PKG_BYTES.length}&sha256=${PKG_SHA}`,
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-c3-sha256')).toBe(PKG_SHA)
    expect(res.headers.get('content-length')).toBe(String(PKG_BYTES.length))
    const got = Buffer.from(await res.arrayBuffer())
    expect(got).toEqual(PKG_BYTES)
  })

  it('fails closed when the .sha256 sidecar disagrees with the manifest', async () => {
    const res = await fetch(
      dlUrl(
        `url=${encodeURIComponent(`https://github.com/${REPO}/releases/download/v0.2.0/${PKG_NAME}`)}&bytes=${PKG_BYTES.length}&sha256=${hex('different')}`,
      ),
    )
    expect(res.status).toBe(422)
  })

  it('refuses a non-github download URL', async () => {
    const res = await fetch(
      dlUrl(`url=${encodeURIComponent('https://evil.example.com/pkg')}&bytes=1&sha256=${hex('x')}`),
    )
    expect(res.status).toBe(400)
  })
})
