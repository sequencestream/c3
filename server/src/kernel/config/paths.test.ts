import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import { resetDbForTests, setDbPath } from '../infra/db.js'
import {
  c3HomeDir,
  loadSettings,
  resetSettingsCacheForTests,
  saveSettings,
  setSettingsPath,
} from './index.js'
import { resetConfigStoreForTests } from './config-store.js'
import { resetLegacyImportForTests } from './import-legacy.js'
import {
  getAgentLang,
  loadPersonalizedFor,
  resetPersonalizedCache,
  savePersonalizedFor,
} from './personalized.js'

// `c3 start --db <path>` relocates the WHOLE c3 instance: the database holds every
// settings class, and the home dir (logs, worktrees, sandbox) follows the file. These
// tests pin that relocation so an isolated launch (e2e, a second instance) can never
// leak into the real `~/.c3`.
let dirA: string
let dirB: string
let prevHome: string | undefined

/** Point every store at `dir/c3.db` with all caches dropped, as a fresh boot would. */
function useDb(dir: string): string {
  const file = join(dir, 'c3.db')
  resetDbForTests()
  resetConfigStoreForTests()
  resetLegacyImportForTests()
  resetSettingsCacheForTests()
  resetPersonalizedCache()
  setDbPath(file)
  return file
}

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), 'c3-paths-a-'))
  dirB = mkdtempSync(join(tmpdir(), 'c3-paths-b-'))
  prevHome = process.env.HOME
  // A throwaway HOME too, so a leak would land somewhere harmless AND be visible.
  process.env.HOME = mkdtempSync(join(tmpdir(), 'c3-paths-home-'))
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetDbForTests()
  resetConfigStoreForTests()
  resetSettingsCacheForTests()
  resetPersonalizedCache()
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

function baseSettings(extra: Partial<SystemSettings> = {}): SystemSettings {
  return {
    agents: [],
    defaultAgentId: SYSTEM_AGENT_ID,
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: '',
    automationAgentId: '',
    ...extra,
  } as SystemSettings
}

describe('--db override', () => {
  it('anchors the c3 home dir at the database file`s directory', () => {
    useDb(dirA)
    expect(c3HomeDir()).toBe(dirA)
  })

  it('writes system settings to the override database and nowhere else', () => {
    const file = useDb(dirA)
    saveSettings(baseSettings({ voiceLang: 'en-US' }))
    expect(existsSync(file)).toBe(true)
    expect(loadSettings().voiceLang).toBe('en-US')
    expect(existsSync(join(process.env.HOME!, '.c3', 'c3.db'))).toBe(false)
    expect(existsSync(join(process.env.HOME!, '.c3', 'settings.json'))).toBe(false)
  })

  it('writes personalized settings into the same database', () => {
    useDb(dirA)
    savePersonalizedFor('alice', { uiLang: 'zh' })
    expect(loadPersonalizedFor('alice')).toEqual({ uiLang: 'zh', theme: 'dark', fontScale: 100 })
    expect(getAgentLang()).toBe('zh')
    expect(existsSync(join(process.env.HOME!, '.c3', 'c3.db'))).toBe(false)
  })

  it('drops every cache on relocation so no store serves the previous database', () => {
    useDb(dirA)
    saveSettings(baseSettings({ voiceLang: 'en-US' }))
    savePersonalizedFor('alice', { uiLang: 'zh' })
    expect(getAgentLang()).toBe('zh')

    // Relocate to a pristine dir: everything must read as "nothing configured", not
    // as the values cached from the first database — an empty database normalizes to
    // the built-in defaults (`zh-CN` here), never to the previous instance's values.
    useDb(dirB)
    expect(loadSettings().voiceLang).toBe('zh-CN')
    expect(loadPersonalizedFor('alice')).toBe(null)
    expect(getAgentLang()).toBe('en')

    // A value written to the second database is what later reads see.
    saveSettings(baseSettings({ voiceLang: 'zh-TW' }))
    expect(loadSettings().voiceLang).toBe('zh-TW')

    // And the first database is untouched by writes against the second.
    useDb(dirA)
    expect(loadSettings().voiceLang).toBe('en-US')
    expect(loadPersonalizedFor('alice')).toEqual({ uiLang: 'zh', theme: 'dark', fontScale: 100 })
  })

  it('keeps the home dir beside the database so logs and worktrees move with it', () => {
    useDb(join(dirA, 'nested'))
    expect(c3HomeDir()).toBe(join(dirA, 'nested'))
  })
})

describe('--settings (deprecated)', () => {
  it('still anchors the home dir when no --db is given', () => {
    resetDbForTests()
    setSettingsPath(join(dirA, 'nested', 'settings.json'))
    expect(c3HomeDir()).toBe(dirname(join(dirA, 'nested', 'settings.json')))
  })

  it('loses to --db, which names the instance', () => {
    setSettingsPath(join(dirB, 'settings.json'))
    useDb(dirA)
    expect(c3HomeDir()).toBe(dirA)
  })
})
