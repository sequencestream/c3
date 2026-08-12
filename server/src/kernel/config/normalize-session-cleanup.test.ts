/**
 * Unit tests for the SystemSettings.sessionCleanup normalize rules and the
 * `getSessionCleanup()` read entry point:
 * - opt-in: absent / false / non-boolean never enables cleanup
 * - retentionDays: floored, clamped up to 1, default (30) omitted, junk dropped
 * - independent of the sandbox config: a legacy per-workspace
 *   `sandbox.sessionRetentionDays` never back-fills the global block
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, getSessionCleanup } from './index.js'
import { releaseConfigDb, seedSystemSettings, useConfigDb } from './config-fixture.js'
import type { SystemSettings } from '@ccc/shared/protocol'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'c3-session-cleanup-test-'))
  useConfigDb(tmpDir)
})

afterEach(() => {
  releaseConfigDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Store `raw` as the whole settings record and load it back normalized. */
function loadWith(raw: Record<string, unknown>): SystemSettings {
  seedSystemSettings(raw)
  return loadSettings()
}

describe('SystemSettings.sessionCleanup normalization', () => {
  it('omits the block entirely when it is absent', () => {
    expect(loadWith({}).sessionCleanup).toBeUndefined()
  })

  it('keeps cleanup off for an explicit false (nothing left to persist)', () => {
    expect(loadWith({ sessionCleanup: { enabled: false } }).sessionCleanup).toBeUndefined()
  })

  it('drops a non-boolean enabled (only a literal true opts in)', () => {
    expect(loadWith({ sessionCleanup: { enabled: 'yes' } }).sessionCleanup).toBeUndefined()
  })

  it('persists an explicit enabled: true', () => {
    expect(loadWith({ sessionCleanup: { enabled: true } }).sessionCleanup).toEqual({
      enabled: true,
    })
  })

  it('floors a fractional retentionDays (7.9 → 7)', () => {
    const s = loadWith({ sessionCleanup: { enabled: true, retentionDays: 7.9 } })
    expect(s.sessionCleanup).toEqual({ enabled: true, retentionDays: 7 })
  })

  it('clamps a sub-day retentionDays up to the minimum (0.5 → 1)', () => {
    const s = loadWith({ sessionCleanup: { enabled: true, retentionDays: 0.5 } })
    expect(s.sessionCleanup).toEqual({ enabled: true, retentionDays: 1 })
  })

  it('omits retentionDays when it equals the default (keeps configs clean)', () => {
    const s = loadWith({ sessionCleanup: { enabled: true, retentionDays: 30 } })
    expect(s.sessionCleanup).toEqual({ enabled: true })
  })

  it('drops a non-positive retentionDays (treated as unset → default applies)', () => {
    const s = loadWith({ sessionCleanup: { enabled: true, retentionDays: 0 } })
    expect(s.sessionCleanup).toEqual({ enabled: true })
  })

  it('drops a non-finite / non-numeric retentionDays', () => {
    for (const bad of [null, 'lots', Number.POSITIVE_INFINITY]) {
      // NaN/Infinity do not survive JSON, so Infinity lands as null — all are junk.
      const s = loadWith({ sessionCleanup: { enabled: true, retentionDays: bad } })
      expect(s.sessionCleanup).toEqual({ enabled: true })
    }
  })

  it('keeps a retention window saved while cleanup is off (it simply does not run)', () => {
    const s = loadWith({ sessionCleanup: { retentionDays: 7 } })
    expect(s.sessionCleanup).toEqual({ retentionDays: 7 })
  })

  it('never derives cleanup from a legacy per-workspace sandbox retention key', () => {
    const s = loadWith({
      projectConfigs: {
        '/home/user/proj': { sandbox: { enabled: true, sessionRetentionDays: 7 } },
      },
    })
    expect(s.sessionCleanup).toBeUndefined()
    expect(getSessionCleanup().enabled).toBe(false)
  })
})

describe('getSessionCleanup()', () => {
  it('reports disabled with the default window when unconfigured', () => {
    loadWith({})
    expect(getSessionCleanup()).toEqual({ enabled: false, retentionDays: 30 })
  })

  it('falls back to the default window when only the switch is set', () => {
    loadWith({ sessionCleanup: { enabled: true } })
    expect(getSessionCleanup()).toEqual({ enabled: true, retentionDays: 30 })
  })

  it('reports the persisted non-default window', () => {
    loadWith({ sessionCleanup: { enabled: true, retentionDays: 14 } })
    expect(getSessionCleanup()).toEqual({ enabled: true, retentionDays: 14 })
  })

  it('stays disabled when a window is saved but the switch is off', () => {
    loadWith({ sessionCleanup: { retentionDays: 14 } })
    expect(getSessionCleanup()).toEqual({ enabled: false, retentionDays: 14 })
  })
})
