/**
 * Storage normalization of the agent REFERENCES — the system role fields and each
 * workspace's `defaultAgentId` override — against the final registry.
 *
 * The rule these tests pin is the one that separates DISABLING from DELETING:
 * disabling still moves a reference on to the next enabled agent (its long-standing
 * order_seq fall-through), while deleting clears it so the role/workspace goes back
 * to *following* whatever default applies. `SystemSettings.defaultAgentId` itself is
 * the end of that chain and is therefore never cleared.
 *
 * They also cover the two things a single `normalize()` return value cannot show:
 * that the cleanup reaches workspaces nobody opened, and that it survives a real
 * save + reload rather than looking right only in memory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { loadSettings, loadWorkspaceSetting, saveSettings, saveWorkspaceSetting } from './index.js'
import {
  readStoredWorkspaceSetting,
  releaseConfigDb,
  resetConfigCaches,
  seedSystemSettings,
  useConfigDb,
} from './config-fixture.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'c3-default-agent-test-'))
  useConfigDb(tmpDir)
})

afterEach(() => {
  releaseConfigDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** A claude agent record as stored on disk; `order_seq` follows the array order. */
function agent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    vendor: 'claude',
    configMode: 'system',
    displayName: id,
    config: { baseUrl: '', apiKey: '', model: '' },
    ...extra,
  }
}

const WS_X = '/tmp/ws-x'
const WS_Y = '/tmp/ws-y'

describe('system role fields — delete clears, disable rewrites', () => {
  it('clears every role that referenced a DELETED agent, leaving empty roles empty', () => {
    // D sits BEFORE the default A, so "the next enabled agent" and "the default"
    // are different agents — which is the whole point of the assertion below.
    seedSystemSettings({
      agents: [agent('d'), agent('a')],
      defaultAgentId: 'a',
      toolAgentId: 'c',
      intentAgentId: 'c',
      specAgentId: 'c',
      specReviewAgentId: '',
      automationAgentId: 'c',
    })
    const s = loadSettings()
    expect(s.toolAgentId).toBe('')
    expect(s.intentAgentId).toBe('')
    expect(s.specAgentId).toBe('')
    expect(s.automationAgentId).toBe('')
    // Already empty stays empty (never auto-filled).
    expect(s.specReviewAgentId).toBe('')
    // And the default is untouched: cleared roles now resolve to A, not to D.
    expect(s.defaultAgentId).toBe('a')
  })

  it('leaves an unrelated, still-valid explicit role choice alone', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('b')],
      defaultAgentId: 'a',
      toolAgentId: 'b',
      intentAgentId: 'gone',
    })
    const s = loadSettings()
    expect(s.toolAgentId).toBe('b')
    expect(s.intentAgentId).toBe('')
  })

  it('rewrites a DISABLED role reference to the next enabled agent instead of clearing it', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('c', { enabled: false }), agent('d')],
      defaultAgentId: 'a',
      toolAgentId: 'c',
      specAgentId: '',
    })
    const s = loadSettings()
    expect(s.toolAgentId).toBe('d')
    expect(s.specAgentId).toBe('')
  })

  it('takes the first enabled agent when a disabled reference has no successor', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('d'), agent('c', { enabled: false })],
      defaultAgentId: 'a',
      toolAgentId: 'c',
    })
    expect(loadSettings().toolAgentId).toBe('a')
  })

  it('falls back to the system id when every agent is disabled', () => {
    seedSystemSettings({
      agents: [agent('a', { enabled: false }), agent('c', { enabled: false })],
      defaultAgentId: 'a',
      toolAgentId: 'c',
    })
    const s = loadSettings()
    expect(s.toolAgentId).toBe(SYSTEM_AGENT_ID)
    expect(s.defaultAgentId).toBe(SYSTEM_AGENT_ID)
  })

  it('never empties the system default itself — a deleted default falls through', () => {
    seedSystemSettings({ agents: [agent('a'), agent('b')], defaultAgentId: 'gone' })
    expect(loadSettings().defaultAgentId).toBe('a')
  })

  it('keeps a group role reference, and rewrites an EMPTIED group rather than clearing it', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('m', { group: 'fast' })],
      defaultAgentId: 'a',
      toolAgentId: '_c3_claude_fast',
      intentAgentId: '_c3_claude_other',
    })
    const s = loadSettings()
    expect(s.toolAgentId).toBe('_c3_claude_fast')
    // `_c3_claude_other` has no enabled member: the settings-normalization branch
    // rewrites it to the first enabled agent. It must NOT be mistaken for a
    // deleted concrete id and cleared.
    expect(s.intentAgentId).toBe('a')
  })
})

describe('workspace defaultAgentId override — inherit, override, cleanup', () => {
  it('normalizes absent / blank / whitespace / non-string to INHERIT (key omitted)', () => {
    seedSystemSettings({
      agents: [agent('a')],
      defaultAgentId: 'a',
      projectConfigs: {
        [WS_X]: {},
        [WS_Y]: { defaultAgentId: '   ' },
      },
    })
    expect(loadWorkspaceSetting(WS_X).defaultAgentId).toBeUndefined()
    expect(loadWorkspaceSetting(WS_Y).defaultAgentId).toBeUndefined()
    // Inheriting must never be stored as a COPY of the system value — otherwise a
    // later system change would not reach this workspace. Asserted against STORAGE
    // after a real save, since that is where a snapshot would have landed (and it
    // also proves the blank row is DELETED rather than persisted as whitespace).
    saveWorkspaceSetting(WS_Y, loadWorkspaceSetting(WS_Y))
    expect(readStoredWorkspaceSetting(WS_Y) ?? {}).not.toHaveProperty('defaultAgentId')
  })

  it('keeps a valid override, trimmed', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('b')],
      defaultAgentId: 'a',
      projectConfigs: { [WS_X]: { defaultAgentId: ' b ' } },
    })
    expect(loadWorkspaceSetting(WS_X).defaultAgentId).toBe('b')
  })

  it('drops the override of a DELETED agent and keeps the workspace’s other fields', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('b')],
      defaultAgentId: 'a',
      projectConfigs: {
        [WS_X]: { defaultAgentId: 'gone', devSkill: '/plan', automationConcurrency: 5 },
        [WS_Y]: { defaultAgentId: 'b' },
      },
    })
    const x = loadWorkspaceSetting(WS_X)
    expect(x.defaultAgentId).toBeUndefined()
    expect(x.devSkill).toBe('/plan')
    expect(x.automationConcurrency).toBe(5)
    // A sibling workspace's own valid override is untouched.
    expect(loadWorkspaceSetting(WS_Y).defaultAgentId).toBe('b')
  })

  it('rewrites a DISABLED override to the next enabled agent (same rule as a role)', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('c', { enabled: false }), agent('d')],
      defaultAgentId: 'a',
      projectConfigs: { [WS_X]: { defaultAgentId: 'c' } },
    })
    expect(loadWorkspaceSetting(WS_X).defaultAgentId).toBe('d')
  })

  it('keeps a group override and rewrites an emptied group, never clearing it', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('m', { group: 'fast' })],
      defaultAgentId: 'a',
      projectConfigs: {
        [WS_X]: { defaultAgentId: '_c3_claude_fast' },
        [WS_Y]: { defaultAgentId: '_c3_claude_other' },
      },
    })
    expect(loadWorkspaceSetting(WS_X).defaultAgentId).toBe('_c3_claude_fast')
    expect(loadWorkspaceSetting(WS_Y).defaultAgentId).toBe('a')
  })
})

describe('cross-scope cleanup reaches storage, not just the returned object', () => {
  it('deleting an agent through saveSettings drops every workspace’s dangling override', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('b')],
      defaultAgentId: 'a',
      toolAgentId: 'b',
      projectConfigs: {
        // WS_Y is never opened or saved by the console in this test — the cleanup
        // must still reach it, because a system save carries the whole map.
        [WS_X]: { defaultAgentId: 'b' },
        [WS_Y]: { defaultAgentId: 'b', devSkill: '/keep' },
      },
    })
    const loaded = loadSettings()
    // Delete B, exactly as an Agents-tab save would.
    saveSettings({ ...loaded, agents: loaded.agents.filter((x) => x.id !== 'b') })

    // Re-read from disk (not the in-memory result) after dropping every cache.
    resetConfigCaches()
    expect(loadSettings().toolAgentId).toBe('')
    expect(readStoredWorkspaceSetting(WS_X)?.defaultAgentId).toBeUndefined()
    const storedY = readStoredWorkspaceSetting(WS_Y)
    expect(storedY?.defaultAgentId).toBeUndefined()
    expect(storedY?.devSkill).toBe('/keep')
    // Both workspaces inherit again.
    expect(loadWorkspaceSetting(WS_X).defaultAgentId).toBeUndefined()
    expect(loadWorkspaceSetting(WS_Y).defaultAgentId).toBeUndefined()
  })

  it('an old page re-submitting the dangling id does not revive it', () => {
    seedSystemSettings({ agents: [agent('a')], defaultAgentId: 'a' })
    // A stale console still holds `b` in its draft and saves it.
    saveWorkspaceSetting(WS_X, { defaultAgentId: 'b' })
    expect(readStoredWorkspaceSetting(WS_X)?.defaultAgentId).toBeUndefined()

    const loaded = loadSettings()
    saveSettings({ ...loaded, toolAgentId: 'b' })
    resetConfigCaches()
    expect(loadSettings().toolAgentId).toBe('')
  })

  it('is idempotent — re-normalizing and re-saving keeps the same result', () => {
    seedSystemSettings({
      agents: [agent('a'), agent('b')],
      defaultAgentId: 'a',
      toolAgentId: 'b',
      projectConfigs: { [WS_X]: { defaultAgentId: 'b' } },
    })
    const first = saveSettings(loadSettings())
    const second = saveSettings(first)
    expect(second.toolAgentId).toBe('b')
    expect(readStoredWorkspaceSetting(WS_X)?.defaultAgentId).toBe('b')
    resetConfigCaches()
    expect(loadWorkspaceSetting(WS_X).defaultAgentId).toBe('b')
  })
})
