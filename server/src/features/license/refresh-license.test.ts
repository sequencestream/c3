import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import { refreshLicense } from './index.js'
import { readLicenseCache, writeLicenseCache } from './store.js'

// The manual term refresh (PL-R7) runs one heartbeat (`runHeartbeatOnce`, which
// reads the cache + calls the global `fetch`), then pushes the refreshed
// `license_state` followed by a `license_refresh_result` ack. We pin C3_DIR to a
// temp cache and stub `fetch` to drive the active / 5xx / network branches, and
// assert the handler triggers the beat (cache mutates) and the right ack.

const OLD_TERM = 1_700_000_000
const NEW_TERM = 1_800_000_000

/** Seed an activated cache so the heartbeat is not skipped (it needs a key + alive token). */
function seedActivatedCache(): void {
  writeLicenseCache({
    installationId: 'inst-fixture',
    licenseKey: 'lk-xyz',
    entitlementToken: 'tok', // bogus is fine: we assert term + ack, not derived state
    aliveToken: 'alive-1',
    state: 'active',
    termEnd: OLD_TERM,
    lastSuccessfulHeartbeat: Date.now(),
    updatedAt: Date.now(),
  })
}

/** Collect the messages the handler pushes over the connection. */
function fakeConn(): { send: ReturnType<typeof vi.fn>; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const send = vi.fn((m: ServerToClient) => {
    sent.push(m)
  })
  return { send, sent }
}

describe('refreshLicense handler (PL-R7 manual term sync)', () => {
  let dir: string
  let saved: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-refresh-license-'))
    saved = process.env.C3_DIR
    process.env.C3_DIR = dir
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (saved === undefined) delete process.env.C3_DIR
    else process.env.C3_DIR = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('on a successful beat: refreshes termEnd, pushes license_state then ok ack', async () => {
    seedActivatedCache()
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'active', termEnd: NEW_TERM }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const conn = fakeConn()

    await refreshLicense({} as never, conn as never, { type: 'refresh_license' })

    // runHeartbeatOnce was actually triggered (PL-R7 reuses it, no new sync path).
    expect(fetchSpy).toHaveBeenCalledOnce()
    // The refreshed term landed in the cache and is surfaced on the state push.
    expect(readLicenseCache()?.termEnd).toBe(NEW_TERM)
    expect(conn.sent).toHaveLength(2)
    expect(conn.sent[0].type).toBe('license_state')
    expect(conn.sent[0]).toMatchObject({ license: { termEnd: NEW_TERM } })
    expect(conn.sent[1]).toEqual({ type: 'license_refresh_result', ok: true })
  })

  it('on an LS 5xx: keeps the cached term, ack ok:false with an http_ reason', async () => {
    seedActivatedCache()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    const conn = fakeConn()

    await refreshLicense({} as never, conn as never, { type: 'refresh_license' })

    // A transient 5xx is fail-soft (grace), never a definitive lapse — the cached
    // term is left untouched (PL-R13).
    expect(readLicenseCache()?.termEnd).toBe(OLD_TERM)
    expect(conn.sent[0].type).toBe('license_state')
    const ack = conn.sent[1]
    expect(ack.type).toBe('license_refresh_result')
    expect(ack).toMatchObject({ ok: false })
    expect(ack.type === 'license_refresh_result' && ack.reason).toContain('http_500')
  })

  it('on a network failure: ack ok:false with a network reason, cached term intact', async () => {
    seedActivatedCache()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const conn = fakeConn()

    await refreshLicense({} as never, conn as never, { type: 'refresh_license' })

    expect(readLicenseCache()?.termEnd).toBe(OLD_TERM)
    const ack = conn.sent[1]
    expect(ack).toMatchObject({ type: 'license_refresh_result', ok: false })
    expect(ack.type === 'license_refresh_result' && ack.reason).toContain('network')
  })
})
