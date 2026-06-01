import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import { getDevSkill, saveSettings, resetSettingsCacheForTests } from './settings.js'

// Redirect `~/.c3` to a throwaway dir (os.homedir() honours $HOME on POSIX) so
// these tests never touch the developer's real settings.json.
let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-settings-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

/** Persist just a `devSkill` value (with the required baseline fields). */
function saveWithDevSkill(devSkill: string | undefined): void {
  saveSettings({ agents: [], defaultAgentId: SYSTEM_AGENT_ID, devSkill } as SystemSettings)
}

describe('getDevSkill normalization', () => {
  it('defaults to empty (no prefix) when unset', () => {
    saveWithDevSkill(undefined)
    expect(getDevSkill()).toBe('')
  })

  it('defaults to empty for a whitespace-only value', () => {
    saveWithDevSkill('   ')
    expect(getDevSkill()).toBe('')
  })

  it('trims surrounding whitespace', () => {
    saveWithDevSkill('  /foo  ')
    expect(getDevSkill()).toBe('/foo')
  })

  it('prepends a missing leading slash', () => {
    saveWithDevSkill('my-skill')
    expect(getDevSkill()).toBe('/my-skill')
  })

  it('keeps an already-slashed command unchanged', () => {
    saveWithDevSkill('/foo')
    expect(getDevSkill()).toBe('/foo')
  })
})
