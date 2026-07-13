/**
 * Unit tests for the workspace automation-gate normalize rule:
 * - `automationEnabled` defaults to `true`; only an explicit boolean `false`
 *   closes the gate. Absent / non-boolean / legacy string values normalize to
 *   `true` so existing workspaces keep auto-dispatching after upgrade.
 * - The normalized boolean is always present, and saving other workspace fields
 *   preserves it (round-trip).
 *
 * Exercised through the public `normalizeWorkspaceSetting(raw)`.
 */
import { describe, it, expect } from 'vitest'
import { normalizeWorkspaceSetting } from './index.js'

describe('automation-gate normalize (via normalizeWorkspaceSetting)', () => {
  it('defaults to enabled when the field is absent', () => {
    expect(normalizeWorkspaceSetting({}).automationEnabled).toBe(true)
  })

  it('defaults to enabled on a null/non-object raw', () => {
    expect(normalizeWorkspaceSetting(null).automationEnabled).toBe(true)
    expect(normalizeWorkspaceSetting(undefined).automationEnabled).toBe(true)
  })

  it('keeps an explicit enabled flag', () => {
    expect(normalizeWorkspaceSetting({ automationEnabled: true }).automationEnabled).toBe(true)
  })

  it('closes the gate only for an explicit boolean false', () => {
    expect(normalizeWorkspaceSetting({ automationEnabled: false }).automationEnabled).toBe(false)
  })

  it('normalizes illegal / legacy values back to enabled', () => {
    // Only the literal boolean `false` disables — a "false" string, 0, or null
    // are corrupted/legacy values and must not silently mute automations.
    expect(normalizeWorkspaceSetting({ automationEnabled: 'false' }).automationEnabled).toBe(true)
    expect(normalizeWorkspaceSetting({ automationEnabled: 0 }).automationEnabled).toBe(true)
    expect(normalizeWorkspaceSetting({ automationEnabled: null }).automationEnabled).toBe(true)
    expect(normalizeWorkspaceSetting({ automationEnabled: 1 }).automationEnabled).toBe(true)
  })

  it('preserves the gate when other fields are saved (round-trip)', () => {
    // Simulate a save that only changes an unrelated field: the closed gate must
    // survive a normalize pass over the full config snapshot.
    const first = normalizeWorkspaceSetting({ automationEnabled: false, devSkill: '/foo' })
    expect(first.automationEnabled).toBe(false)
    const roundTripped = normalizeWorkspaceSetting({ ...first, devSkill: '/bar' })
    expect(roundTripped.automationEnabled).toBe(false)
    expect(roundTripped.devSkill).toBe('/bar')
  })
})
