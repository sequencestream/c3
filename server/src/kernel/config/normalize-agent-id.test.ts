/**
 * Unit tests for the agent-id fallback minted during normalize (2026-08-07-007):
 * - An id-less record gets `<current millisecond>-<counter>`, never a placeholder
 *   word like `new`/`copy`.
 * - Two id-less records in the same pass both survive with distinct ids (the
 *   counter guards them against the de-dupe that drops a repeated id).
 * - A record that carries an id keeps it verbatim, legacy prefixes included.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, setSettingsPath, resetSettingsCacheForTests } from './index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'c3-agent-id-test-'))
})

afterEach(() => {
  resetSettingsCacheForTests()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Write a settings.json carrying `agents` verbatim and load it back normalized. */
function loadWithAgents(agents: unknown[]) {
  const file = join(tmpDir, 'settings.json')
  writeFileSync(file, JSON.stringify({ agents }))
  setSettingsPath(file)
  resetSettingsCacheForTests()
  return loadSettings()
}

const claude = (extra: Record<string, unknown> = {}) => ({
  vendor: 'claude',
  configMode: 'custom',
  displayName: 'A',
  config: { baseUrl: 'https://a', apiKey: 'k', model: '' },
  ...extra,
})

describe('agent id fallback on normalize', () => {
  it('mints a millisecond-based id for an id-less agent', () => {
    const before = Date.now()
    const s = loadWithAgents([claude()])
    const after = Date.now()

    expect(s.agents).toHaveLength(1)
    const id = s.agents[0].id
    expect(id).toMatch(/^\d+-\d+$/)
    expect(id).not.toMatch(/new|copy/i)
    const stamp = Number(id.split('-')[0])
    expect(stamp).toBeGreaterThanOrEqual(before)
    expect(stamp).toBeLessThanOrEqual(after)
  })

  it('keeps both id-less agents with distinct ids in a single pass', () => {
    const s = loadWithAgents([claude({ displayName: 'A' }), claude({ displayName: 'B' })])

    expect(s.agents.map((a) => a.displayName)).toEqual(['A', 'B'])
    const [a, b] = s.agents.map((x) => x.id)
    expect(a).not.toBe(b)
    for (const id of [a, b]) expect(id).toMatch(/^\d+-\d+$/)
  })

  it('leaves an existing id untouched, legacy prefixes included', () => {
    const s = loadWithAgents([claude({ id: 'new-1750000000000-0' }), claude({ id: 'a1' })])
    expect(s.agents.map((a) => a.id)).toEqual(['new-1750000000000-0', 'a1'])
  })
})
