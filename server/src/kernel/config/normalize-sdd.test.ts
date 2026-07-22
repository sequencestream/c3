/**
 * Unit tests for the SDD workspace-setting normalize rules:
 * - `sddEnabled` defaults to true; only an explicit boolean `false` disables it.
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
    expect(result.sddEnabled).toBe(true)
    expect(result.gitBranchMode).toBe('worktree')
  })

  it('back-fills defaults on a null/non-object raw', () => {
    const result = normalizeWorkspaceSetting(null)
    expect(result.sddEnabled).toBe(true)
    expect(result.gitBranchMode).toBe('worktree')
    expect(normalizeWorkspaceSetting('invalid')).toMatchObject({
      gitBranchMode: 'worktree',
      sddEnabled: true,
    })
  })

  it('keeps an explicit enabled flag', () => {
    const result = normalizeWorkspaceSetting({ sddEnabled: true })
    expect(result.sddEnabled).toBe(true)
  })

  it('preserves explicit false and rejects illegal types by defaulting to true', () => {
    expect(normalizeWorkspaceSetting({ sddEnabled: 'true' }).sddEnabled).toBe(true)
    expect(normalizeWorkspaceSetting({ sddEnabled: 1 }).sddEnabled).toBe(true)
    expect(normalizeWorkspaceSetting({ sddEnabled: false }).sddEnabled).toBe(false)
  })

  it('preserves legal branch modes and defaults illegal values to worktree', () => {
    expect(normalizeWorkspaceSetting({ gitBranchMode: 'current-branch' }).gitBranchMode).toBe(
      'current-branch',
    )
    expect(normalizeWorkspaceSetting({ gitBranchMode: 'worktree' }).gitBranchMode).toBe('worktree')
    expect(normalizeWorkspaceSetting({ gitBranchMode: 'invalid' }).gitBranchMode).toBe('worktree')
  })

  it('is idempotent after defaults and explicit values are normalized', () => {
    const defaults = normalizeWorkspaceSetting({})
    expect(normalizeWorkspaceSetting(defaults)).toEqual(defaults)
    const explicit = normalizeWorkspaceSetting({
      gitBranchMode: 'current-branch',
      sddEnabled: false,
    })
    expect(normalizeWorkspaceSetting(explicit)).toEqual(explicit)
  })

  it('never persists a client-supplied spec directory (REQ-3: read-only/fixed)', () => {
    // The spec root is centralized and non-configurable; any spec-dir input is
    // dropped — the normalized config carries no spec directory field.
    const result = normalizeWorkspaceSetting({ sddEnabled: true, specPath: 'docs/specs' })
    expect('specPath' in result).toBe(false)
    expect((result as Record<string, unknown>).specPath).toBeUndefined()
  })
})
