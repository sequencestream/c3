/**
 * Unit tests for the SDD workspace-setting normalize rules:
 * - `sddEnabled` defaults to false; only an explicit boolean `true` enables it.
 * - There is NO configurable spec directory: the spec root is fixed/centralized,
 *   so any `specPath`-like input is ignored and never persisted (REQ-3).
 *
 * Exercised through the public `normalizeWorkspaceSetting(raw)`.
 */
import { describe, it, expect } from 'vitest'
import { normalizeWorkspaceSetting } from './index.js'

describe('SDD normalize (via normalizeWorkspaceSetting)', () => {
  it('back-fills defaults when the fields are absent', () => {
    const result = normalizeWorkspaceSetting({})
    expect(result.sddEnabled).toBe(false)
  })

  it('back-fills defaults on a null/non-object raw', () => {
    const result = normalizeWorkspaceSetting(null)
    expect(result.sddEnabled).toBe(false)
  })

  it('keeps an explicit enabled flag', () => {
    const result = normalizeWorkspaceSetting({ sddEnabled: true })
    expect(result.sddEnabled).toBe(true)
  })

  it('rejects illegal sddEnabled types by defaulting to false', () => {
    expect(normalizeWorkspaceSetting({ sddEnabled: 'true' }).sddEnabled).toBe(false)
    expect(normalizeWorkspaceSetting({ sddEnabled: 1 }).sddEnabled).toBe(false)
    expect(normalizeWorkspaceSetting({ sddEnabled: false }).sddEnabled).toBe(false)
  })

  it('never persists a client-supplied spec directory (REQ-3: read-only/fixed)', () => {
    // The spec root is centralized and non-configurable; any spec-dir input is
    // dropped — the normalized config carries no spec directory field.
    const result = normalizeWorkspaceSetting({ sddEnabled: true, specPath: 'docs/specs' })
    expect('specPath' in result).toBe(false)
    expect((result as Record<string, unknown>).specPath).toBeUndefined()
  })
})
