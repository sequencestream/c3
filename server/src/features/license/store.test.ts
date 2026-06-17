import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GRACE_WINDOW_MS,
  deriveEntitlement,
  getOrCreateInstallationId,
  licenseFilePath,
  readLicenseCache,
  recordHeartbeatFailure,
  recordHeartbeatLapse,
  recordHeartbeatSuccess,
  saveActivation,
  writeLicenseCache,
} from './store.js'

// The same Go-signed fixture used by token.test.ts (window [1700000000,1702592000)).
const GO_SIGNED_TOKEN =
  'v1.eyJpbnN0YWxsYXRpb25JZCI6Imluc3QtZml4dHVyZSIsImxpY2Vuc2VJZCI6IjciLCJwbGFuIjoidHJpYWwtMW0iLCJzdGF0dXMiOiJhY3RpdmUiLCJ0ZXJtU3RhcnQiOjE3MDAwMDAwMDAsInRlcm1FbmQiOjE3MDI1OTIwMDAsImlzc3VlZEF0IjoxNzAwMDAwMDAwLCJraWQiOiIxMGRiMGQyMjFjMTI1NzNjIn0.cNsvjU1NoYycw5ENEzCrjXtc5BH_IgQa9AfZhxfJj04pKo559NwfLT8pquQF2sp3G-Lim6hsrsRmg8m-jJGhBQ'
const WITHIN = 1_700_500_000

let dir: string
let savedC3Dir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-license-'))
  savedC3Dir = process.env.C3_DIR
  process.env.C3_DIR = dir
})

afterEach(() => {
  if (savedC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = savedC3Dir
  rmSync(dir, { recursive: true, force: true })
})

describe('license cache persistence', () => {
  it('writes the entitlement cache with 0600 permissions (sensitive file)', () => {
    writeLicenseCache({
      installationId: 'inst-1',
      licenseKey: 'lk-1',
      entitlementToken: 'tok',
      aliveToken: 'av',
      plan: 'trial-1m',
      state: 'active',
      termEnd: 123,
      lastSuccessfulHeartbeat: null,
      updatedAt: 1,
    })
    const mode = statSync(licenseFilePath()).mode & 0o777
    // The file holds a bearer credential; only the owner may read it.
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600)
    }
  })

  it('round-trips the cache through disk', () => {
    const cache = {
      installationId: 'inst-2',
      licenseKey: 'lk-2',
      entitlementToken: 'e',
      aliveToken: 'a',
      plan: 'trial-1m',
      state: 'active' as const,
      termEnd: 999,
      lastSuccessfulHeartbeat: 42,
      updatedAt: 7,
    }
    writeLicenseCache(cache)
    expect(readLicenseCache()).toEqual(cache)
  })

  it('mints a stable installation id and persists it 0600', () => {
    const id = getOrCreateInstallationId()
    expect(id).toMatch(/[0-9a-f-]{36}/)
    expect(getOrCreateInstallationId()).toBe(id) // stable across calls
    if (process.platform !== 'win32') {
      expect(statSync(licenseFilePath()).mode & 0o777).toBe(0o600)
    }
  })

  it('saveActivation records the key + alive token and marks active', () => {
    const installationId = getOrCreateInstallationId()
    const cache = saveActivation({
      installationId,
      licenseKey: 'lk-secret',
      entitlementToken: GO_SIGNED_TOKEN,
      aliveToken: 'av-secret',
      plan: 'trial-1m',
      termEnd: 1_702_592_000,
    })
    expect(cache.state).toBe('active')
    expect(readLicenseCache()?.aliveToken).toBe('av-secret')
    expect(readLicenseCache()?.licenseKey).toBe('lk-secret')
  })

  it('returns undefined cache as unactivated', () => {
    expect(deriveEntitlement(undefined, WITHIN)).toEqual({ state: 'unactivated' })
  })
})

describe('deriveEntitlement from the cached token (PL-R5)', () => {
  function seedActive(installationId: string): void {
    saveActivation({
      installationId,
      licenseKey: 'lk',
      entitlementToken: GO_SIGNED_TOKEN,
      aliveToken: 'av',
      plan: 'trial-1m',
      termEnd: 1_702_592_000,
    })
  }

  it('derives active for a verified token within its window', () => {
    seedActive('inst-3')
    expect(deriveEntitlement(readLicenseCache(), WITHIN).state).toBe('active')
  })

  it('derives expired once the token window has passed', () => {
    seedActive('inst-4')
    expect(deriveEntitlement(readLicenseCache(), 1_702_592_001).state).toBe('expired')
  })

  it('derives unactivated when the cached token is empty', () => {
    const id = getOrCreateInstallationId()
    expect(deriveEntitlement(readLicenseCache(), WITHIN)).toEqual({
      state: 'unactivated',
      installationId: id,
    })
  })
})

describe('heartbeat cache transitions (PL-R3/PL-R4/PL-R8)', () => {
  function seedActive(): void {
    saveActivation({
      installationId: 'inst-hb',
      licenseKey: 'lk',
      entitlementToken: GO_SIGNED_TOKEN,
      aliveToken: 'av',
      plan: 'trial-1m',
      termEnd: 1_702_592_000,
    })
  }

  it('recordHeartbeatSuccess resets grace and caches a refreshed token', () => {
    seedActive()
    const next = recordHeartbeatSuccess({ entitlementToken: 'refreshed', termEnd: 555 })
    expect(next?.state).toBe('active')
    expect(next?.entitlementToken).toBe('refreshed')
    expect(next?.termEnd).toBe(555)
    expect(next?.lastSuccessfulHeartbeat).not.toBeNull()
  })

  it('recordHeartbeatLapse marks a definitive non-active verdict', () => {
    seedActive()
    expect(recordHeartbeatLapse('revoked')?.state).toBe('revoked')
    expect(readLicenseCache()?.state).toBe('revoked')
  })

  it('recordHeartbeatFailure stays in grace within the window, then expires', () => {
    seedActive()
    const now = 1_000_000_000_000
    // last success is "now" → within grace.
    recordHeartbeatSuccess()
    writeLicenseCache({ ...readLicenseCache()!, lastSuccessfulHeartbeat: now })
    expect(recordHeartbeatFailure(now + GRACE_WINDOW_MS - 1)?.state).toBe('grace')
    expect(recordHeartbeatFailure(now + GRACE_WINDOW_MS + 1)?.state).toBe('expired')
  })

  it('recordHeartbeatFailure does not resurrect a revoked license', () => {
    seedActive()
    recordHeartbeatLapse('revoked')
    expect(recordHeartbeatFailure()?.state).toBe('revoked')
  })
})
