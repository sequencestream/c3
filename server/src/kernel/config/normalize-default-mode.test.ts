/**
 * `normalizeDefaultMode` via `normalizeWorkspaceSetting` / `saveWorkspaceSetting`.
 *
 * Root cause this gates: the UI can edit `defaultMode.cursor`, but the old
 * normalizer only kept `claude`/`codex` and retained illegal string tokens
 * without a catalog check. Cursor sessions then seeded/`session_selected` with
 * `'default'` (∉ cursor catalog) → SessionTitleBar BaseDropdown empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getDefaultMode,
  loadWorkspaceSetting,
  normalizeWorkspaceSetting,
  resetSettingsCacheForTests,
  saveWorkspaceSetting,
  setSettingsPath,
} from './index.js'
import type { WorkspaceSetting } from '@ccc/shared/protocol'

const TEST_PROJ = '/tmp/c3-default-mode-proj'

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-ndefmode-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  setSettingsPath(join(dir, 'settings.json'))
  resetSettingsCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('normalizeDefaultMode (via normalizeWorkspaceSetting)', () => {
  it('includes cursor with catalog defaultToken when defaultMode is absent', () => {
    const result = normalizeWorkspaceSetting({})
    expect(result.defaultMode).toEqual({
      claude: 'default',
      codex: 'auto',
      cursor: 'agent',
    })
  })

  it('preserves a legal defaultMode.cursor round-trip through saveWorkspaceSetting', () => {
    const saved = saveWorkspaceSetting(TEST_PROJ, {
      defaultMode: { claude: 'default', codex: 'auto', cursor: 'plan' },
    } as WorkspaceSetting)
    expect(saved.defaultMode?.cursor).toBe('plan')
    expect(loadWorkspaceSetting(TEST_PROJ).defaultMode?.cursor).toBe('plan')
    expect(getDefaultMode(TEST_PROJ, 'cursor')).toBe('plan')
  })

  it('legacy single string fan-out: catalog gate per vendor (default → cursor agent)', () => {
    const result = normalizeWorkspaceSetting({ defaultMode: 'default' })
    expect(result.defaultMode).toEqual({
      claude: 'default',
      codex: 'auto',
      cursor: 'agent',
    })
  })

  it('legacy single string fan-out: auto stays on claude/codex, cursor falls back to agent', () => {
    const result = normalizeWorkspaceSetting({ defaultMode: 'auto' })
    expect(result.defaultMode).toEqual({
      claude: 'auto',
      codex: 'auto',
      cursor: 'agent',
    })
  })

  it('legacy plan is accepted by claude and cursor; codex falls back to auto', () => {
    const result = normalizeWorkspaceSetting({ defaultMode: 'plan' })
    expect(result.defaultMode).toEqual({
      claude: 'plan',
      codex: 'auto',
      cursor: 'plan',
    })
  })

  it('Record path: illegal cursor token (default) falls back to agent, not kept as-is', () => {
    const result = normalizeWorkspaceSetting({
      defaultMode: { claude: 'acceptEdits', codex: 'read-only', cursor: 'default' },
    })
    expect(result.defaultMode?.claude).toBe('acceptEdits')
    expect(result.defaultMode?.codex).toBe('read-only')
    expect(result.defaultMode?.cursor).toBe('agent')
  })

  it('Record path: missing cursor key fills agent; legal cursor full-access kept', () => {
    expect(
      normalizeWorkspaceSetting({
        defaultMode: { claude: 'default', codex: 'auto' },
      }).defaultMode?.cursor,
    ).toBe('agent')
    expect(
      normalizeWorkspaceSetting({
        defaultMode: { claude: 'default', codex: 'auto', cursor: 'full-access' },
      }).defaultMode?.cursor,
    ).toBe('full-access')
  })

  it('keeps Codex dual-policy object without string-catalog gate', () => {
    const policy = { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }
    const result = normalizeWorkspaceSetting({
      defaultMode: { claude: 'default', codex: policy, cursor: 'agent' },
    })
    expect(result.defaultMode?.codex).toEqual(policy)
    expect(result.defaultMode?.cursor).toBe('agent')
  })

  it('Claude/Codex legal tokens are not silently rewritten', () => {
    const result = normalizeWorkspaceSetting({
      defaultMode: { claude: 'plan', codex: 'full-access', cursor: 'agent' },
    })
    expect(result.defaultMode).toEqual({
      claude: 'plan',
      codex: 'full-access',
      cursor: 'agent',
    })
  })
})
