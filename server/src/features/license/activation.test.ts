import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSignInUrl, collectBindingOnce } from './activation.js'
import { readLicenseCache } from './store.js'

// The same Go-signed fixture used by token.test.ts: installationId 'inst-fixture',
// window [1700000000, 1702592000). Pinning it proves the checkbind collector
// verifies a real entitlement before caching (PL-R5).
const GO_SIGNED_TOKEN =
  'v1.eyJpbnN0YWxsYXRpb25JZCI6Imluc3QtZml4dHVyZSIsImxpY2Vuc2VJZCI6IjciLCJzdGF0dXMiOiJhY3RpdmUiLCJ0ZXJtU3RhcnQiOjE3MDAwMDAwMDAsInRlcm1FbmQiOjE3MDI1OTIwMDAsImlzc3VlZEF0IjoxNzAwMDAwMDAwLCJraWQiOiI4ODcxZmZlNzU3YWRlMmQwIn0.1RSAyP0su56tLiuhScRAdt0yxSiNhNWEGTCoKgE6VoElmEdWDRojfrFbjn2Uac4gcekSaaKe_KVGyc3TMY1CBA'
const WITHIN = 1_700_500_000

/** A fake fetch returning one JSON checkbind response (status 200 unless noted). */
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('buildSignInUrl', () => {
  it('lands on the SPA root carrying the binding round', () => {
    const url = new URL(buildSignInUrl('https://ls.example.com', 'inst-1', 'r'.repeat(32)))
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('installId')).toBe('inst-1')
    expect(url.searchParams.get('requestId')).toBe('r'.repeat(32))
  })

  it('trims a trailing slash on the base without doubling', () => {
    const url = new URL(buildSignInUrl('https://ls.example.com/', 'i', 'q'))
    expect(url.origin + url.pathname).toBe('https://ls.example.com/')
  })
})

describe('collectBindingOnce', () => {
  let dir: string
  let saved: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-activation-'))
    saved = process.env.C3_DIR
    process.env.C3_DIR = dir
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.C3_DIR
    else process.env.C3_DIR = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports pending while the browser bind is incomplete', async () => {
    const out = await collectBindingOnce({
      installId: 'inst-fixture',
      requestId: 'q'.repeat(32),
      fetchImpl: fakeFetch({ status: 'pending' }),
    })
    expect(out.kind).toBe('pending')
    expect(readLicenseCache()).toBeUndefined()
  })

  it('treats a transient 503 as pending (keep polling)', async () => {
    const out = await collectBindingOnce({
      installId: 'inst-fixture',
      requestId: 'q'.repeat(32),
      fetchImpl: fakeFetch({ error: { message: 'unavailable' } }, 503),
    })
    expect(out.kind).toBe('pending')
  })

  it('persists the verified entitlement on an active round', async () => {
    const out = await collectBindingOnce({
      installId: 'inst-fixture',
      requestId: 'q'.repeat(32),
      nowSeconds: WITHIN,
      fetchImpl: fakeFetch({
        status: 'active',
        licenseKey: 'lk-xyz',
        aliveToken: 'alive-1',
        entitlementToken: GO_SIGNED_TOKEN,
        termEnd: 1_702_592_000,
      }),
    })
    expect(out.kind).toBe('active')
    const cache = readLicenseCache()
    expect(cache?.state).toBe('active')
    expect(cache?.licenseKey).toBe('lk-xyz')
    expect(cache?.aliveToken).toBe('alive-1')
    expect(cache?.entitlementToken).toBe(GO_SIGNED_TOKEN)
  })

  it('fails (no cache) when the entitlement is bound to another installation', async () => {
    const out = await collectBindingOnce({
      installId: 'someone-else',
      requestId: 'q'.repeat(32),
      nowSeconds: WITHIN,
      fetchImpl: fakeFetch({
        status: 'active',
        licenseKey: 'lk-xyz',
        aliveToken: 'alive-1',
        entitlementToken: GO_SIGNED_TOKEN,
        termEnd: 1_702_592_000,
      }),
    })
    expect(out.kind).toBe('failed')
    expect(readLicenseCache()).toBeUndefined()
  })

  it('fails when an active response omits the tokens', async () => {
    const out = await collectBindingOnce({
      installId: 'inst-fixture',
      requestId: 'q'.repeat(32),
      fetchImpl: fakeFetch({ status: 'active', licenseKey: 'lk' }),
    })
    expect(out.kind).toBe('failed')
  })
})
