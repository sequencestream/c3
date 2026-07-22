import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  currentUpdateStatus,
  resetUpdateStatusForTests,
  runUpdateCheckOnce,
  startUpdateCheckScheduler,
  stopUpdateCheckScheduler,
} from './update-checker.js'
import { VERSION } from '../../version.js'
import { compareVersions } from '../../upgrade.js'

// Versions guaranteed strictly newer / older than the running VERSION (which is
// `0.0.0-dev` under test but could be a real release). `999.999.999` outranks any
// realistic version; `0.0.0-0` (core 0.0.0 with the lowest-ranking numeric
// prerelease) is below every other version. Sanity asserts pin the relationship.
const HIGHER = '999.999.999'
const LOWER = '0.0.0-0'

/** Build a fake `fetch` that returns one canned response (or throws). */
function fetchReturning(resp: Partial<Response> & { throws?: unknown }): typeof fetch {
  return vi.fn(async () => {
    if (resp.throws) throw resp.throws
    return resp as unknown as Response
  }) as unknown as typeof fetch
}

function okJson(body: unknown): Partial<Response> {
  return { ok: true, status: 200, json: async () => body }
}

const BASE = 'https://ls.test'

describe('runUpdateCheckOnce — version comparison', () => {
  beforeEach(() => resetUpdateStatusForTests())

  it('remote higher than local → available=true with latestVersion + checkedAt', async () => {
    const snap = await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning(okJson({ version: `v${HIGHER}`, batch: 'b1' })),
      now: 1234,
    })
    expect(compareVersions(HIGHER, VERSION)).toBeGreaterThan(0) // sanity
    expect(snap).toEqual({ available: true, latestVersion: HIGHER, checkedAt: 1234 })
    expect(currentUpdateStatus()).toEqual(snap)
  })

  it('normalizes a leading `v` off the remote version', async () => {
    const snap = await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning(okJson({ version: 'v999.0.0' })),
      now: 1,
    })
    expect(snap.latestVersion).toBe('999.0.0')
  })

  it('remote lower than local → available=false (still records the version)', async () => {
    expect(compareVersions(LOWER, VERSION)).toBeLessThan(0) // sanity
    const snap = await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning(okJson({ version: LOWER })),
      now: 7,
    })
    expect(snap.available).toBe(false)
    expect(snap.latestVersion).toBe(LOWER)
  })

  it('remote equal to local → available=false', async () => {
    const snap = await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning(okJson({ version: VERSION })),
      now: 7,
    })
    expect(snap.available).toBe(false)
  })
})

describe('runUpdateCheckOnce — fail-soft', () => {
  beforeEach(() => resetUpdateStatusForTests())

  // Seed a successful "available" snapshot, then assert each failure path keeps it.
  async function seedAvailable(): Promise<void> {
    await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning(okJson({ version: `v${HIGHER}` })),
      now: 100,
    })
  }

  it('network error → does not throw, preserves last snapshot', async () => {
    await seedAvailable()
    const snap = await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning({ throws: new Error('ECONNREFUSED') }),
    })
    expect(snap).toEqual({ available: true, latestVersion: HIGHER, checkedAt: 100 })
  })

  it('non-2xx → does not throw, preserves last snapshot', async () => {
    await seedAvailable()
    const snap = await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning({ ok: false, status: 503 }),
    })
    expect(snap.available).toBe(true)
    expect(snap.latestVersion).toBe(HIGHER)
  })

  it('malformed JSON → does not throw, preserves last snapshot', async () => {
    await seedAvailable()
    const snap = await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json')
        },
      }),
    })
    expect(snap.latestVersion).toBe(HIGHER)
  })

  it('missing/illegal version field → does not throw, preserves last snapshot', async () => {
    await seedAvailable()
    for (const body of [{}, { version: '' }, { version: '   ' }, { version: 42 }]) {
      const snap = await runUpdateCheckOnce({
        url: BASE,
        fetchImpl: fetchReturning(okJson(body)),
      })
      expect(snap).toEqual({ available: true, latestVersion: HIGHER, checkedAt: 100 })
    }
  })

  it('failure from the initial (unknown) snapshot leaves it unknown+invisible', async () => {
    const snap = await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning({ ok: false, status: 500 }),
    })
    expect(snap).toEqual({ available: false, latestVersion: null, checkedAt: null })
  })
})

describe('runUpdateCheckOnce — default path avoids the rate-limited JSON API', () => {
  beforeEach(() => resetUpdateStatusForTests())

  /** A manual-redirect response from `github.com/<repo>/releases/latest` → tag page. */
  function redirectTo(tag: string): Partial<Response> {
    return {
      status: 302,
      headers: new Headers({ location: `https://github.com/o/r/releases/tag/${tag}` }),
    }
  }

  it('no override → resolves the tag from the releases redirect, never touching api.github.com', async () => {
    const fetchImpl = vi.fn(
      async () => redirectTo(`v${HIGHER}`) as unknown as Response,
    ) as unknown as typeof fetch
    const snap = await runUpdateCheckOnce({ fetchImpl, now: 7 })
    expect(snap).toEqual({ available: true, latestVersion: HIGHER, checkedAt: 7 })
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) =>
      String(u),
    )
    expect(urls.every((u) => !u.includes('api.github.com'))).toBe(true)
  })

  it('redirect without a usable tag → falls back to the JSON API', async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes('api.github.com')
        ? (okJson({ tag_name: `v${HIGHER}` }) as unknown as Response)
        : ({ status: 200, headers: new Headers() } as unknown as Response),
    ) as unknown as typeof fetch
    const snap = await runUpdateCheckOnce({ fetchImpl, now: 8 })
    expect(snap).toEqual({ available: true, latestVersion: HIGHER, checkedAt: 8 })
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) =>
      String(u),
    )
    expect(urls.some((u) => u.includes('api.github.com'))).toBe(true)
  })

  it('rate-limited API fallback (403) → fail-soft, keeps the last snapshot', async () => {
    await runUpdateCheckOnce({
      url: BASE,
      fetchImpl: fetchReturning(okJson({ version: `v${HIGHER}` })),
      now: 100,
    })
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes('api.github.com')
        ? ({
            ok: false,
            status: 403,
            headers: new Headers({ 'x-ratelimit-remaining': '0' }),
          } as unknown as Response)
        : ({ status: 200, headers: new Headers() } as unknown as Response),
    ) as unknown as typeof fetch
    const snap = await runUpdateCheckOnce({ fetchImpl })
    expect(snap).toEqual({ available: true, latestVersion: HIGHER, checkedAt: 100 })
  })
})

describe('startUpdateCheckScheduler — timer loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetUpdateStatusForTests()
  })
  afterEach(() => {
    stopUpdateCheckScheduler()
    vi.useRealTimers()
  })

  it('runs once after the initial delay, then repeats on the fixed interval', async () => {
    const fetchImpl = fetchReturning(okJson({ version: `v${HIGHER}` }))
    const onChange = vi.fn()
    startUpdateCheckScheduler({ url: BASE, fetchImpl, onChange })

    // Nothing before the initial delay.
    expect(fetchImpl).not.toHaveBeenCalled()

    // First check fires after the initial delay.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(currentUpdateStatus().available).toBe(true)

    // Then re-checks on the 24h cadence.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stopUpdateCheckScheduler clears the timer (no further checks)', async () => {
    const fetchImpl = fetchReturning(okJson({ version: `v${HIGHER}` }))
    startUpdateCheckScheduler({ url: BASE, fetchImpl })
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    stopUpdateCheckScheduler()
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('repeated start does not multiplex loops (a prior loop is stopped first)', async () => {
    const fetchImpl = fetchReturning(okJson({ version: `v${HIGHER}` }))
    startUpdateCheckScheduler({ url: BASE, fetchImpl })
    startUpdateCheckScheduler({ url: BASE, fetchImpl })
    await vi.advanceTimersByTimeAsync(5000)
    // Only one loop is live → exactly one check, not two.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
