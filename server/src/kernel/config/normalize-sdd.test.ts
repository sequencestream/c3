/**
 * Unit tests for the SDD workspace-setting normalize rules:
 * - `sddEnabled` defaults to false; only an explicit boolean `true` enables it.
 * - `specPath` is trimmed; absent / blank / non-string falls back to `.specs`.
 *
 * Exercised through the public `normalizeWorkspaceSetting(raw)`.
 */
import { describe, it, expect } from 'vitest'
import { normalizeWorkspaceSetting } from './index.js'

describe('SDD normalize (via normalizeWorkspaceSetting)', () => {
  it('back-fills defaults when the fields are absent', () => {
    const result = normalizeWorkspaceSetting({})
    expect(result.sddEnabled).toBe(false)
    expect(result.specPath).toBe('.specs')
  })

  it('back-fills defaults on a null/non-object raw', () => {
    const result = normalizeWorkspaceSetting(null)
    expect(result.sddEnabled).toBe(false)
    expect(result.specPath).toBe('.specs')
  })

  it('keeps an explicit enabled + custom path', () => {
    const result = normalizeWorkspaceSetting({ sddEnabled: true, specPath: 'docs/specs' })
    expect(result.sddEnabled).toBe(true)
    expect(result.specPath).toBe('docs/specs')
  })

  it('trims the spec path', () => {
    const result = normalizeWorkspaceSetting({ sddEnabled: true, specPath: '  my-specs  ' })
    expect(result.specPath).toBe('my-specs')
  })

  it('rejects illegal sddEnabled types by defaulting to false', () => {
    expect(normalizeWorkspaceSetting({ sddEnabled: 'true' }).sddEnabled).toBe(false)
    expect(normalizeWorkspaceSetting({ sddEnabled: 1 }).sddEnabled).toBe(false)
    expect(normalizeWorkspaceSetting({ sddEnabled: false }).sddEnabled).toBe(false)
  })

  it('rejects illegal / blank specPath by falling back to .specs', () => {
    expect(normalizeWorkspaceSetting({ specPath: 42 }).specPath).toBe('.specs')
    expect(normalizeWorkspaceSetting({ specPath: '   ' }).specPath).toBe('.specs')
    expect(normalizeWorkspaceSetting({ specPath: '' }).specPath).toBe('.specs')
  })
})
