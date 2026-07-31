import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import {
  c3HomeDir,
  loadSettings,
  resetSettingsCacheForTests,
  saveSettings,
  setSettingsPath,
} from './index.js'
import { getAgentLang, loadPersonalizedFor, savePersonalizedFor } from './personalized.js'
import { readJsonFile } from './store.js'

// `c3 start --settings <path>` relocates the WHOLE config dir, which every store
// that persists into settings.json must follow — including the personalized-settings
// store, whose keys live in that same file. These tests pin that relocation so an
// isolated launch (e2e, a second instance) can never leak into the real `~/.c3`.
let dirA: string
let dirB: string
let prevHome: string | undefined

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
  resetSettingsCacheForTests()
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

describe('--settings override', () => {
  it('anchors the c3 home dir at the override file`s directory', () => {
    setSettingsPath(join(dirA, 'settings.json'))
    expect(c3HomeDir()).toBe(dirA)
  })

  it('writes system settings to the override file and nowhere else', () => {
    const file = join(dirA, 'settings.json')
    setSettingsPath(file)
    saveSettings(baseSettings({ voiceLang: 'en-US' }))
    expect(readJsonFile<SystemSettings>(file)?.voiceLang).toBe('en-US')
    expect(existsSync(join(process.env.HOME!, '.c3', 'settings.json'))).toBe(false)
  })

  it('writes personalized settings into the same override file', () => {
    const file = join(dirA, 'settings.json')
    setSettingsPath(file)
    savePersonalizedFor('alice', { uiLang: 'zh' })
    const raw = readJsonFile<Record<string, unknown>>(file) ?? {}
    expect(raw.personalizedSettings).toEqual({ alice: { uiLang: 'zh', theme: 'dark' } })
    expect(raw.agentLang).toBe('zh')
    expect(existsSync(join(process.env.HOME!, '.c3', 'settings.json'))).toBe(false)
  })

  it('drops every cache on relocation so no store serves the previous file', () => {
    setSettingsPath(join(dirA, 'settings.json'))
    saveSettings(baseSettings({ voiceLang: 'en-US' }))
    savePersonalizedFor('alice', { uiLang: 'zh' })
    expect(getAgentLang()).toBe('zh')

    // Relocate to a pristine dir: everything must read as "nothing configured",
    // not as the values cached from the first file. A missing file falls back to the
    // clean agent-registry default, which carries no voiceLang at all.
    setSettingsPath(join(dirB, 'settings.json'))
    expect(loadSettings().voiceLang).toBeUndefined()
    expect(loadPersonalizedFor('alice')).toBe(null)
    expect(getAgentLang()).toBe('en')

    // A value written to the second file is what later reads see.
    saveSettings(baseSettings({ voiceLang: 'zh-TW' }))
    expect(loadSettings().voiceLang).toBe('zh-TW')

    // And the first file is untouched by reads against the second.
    const first = readJsonFile<Record<string, unknown>>(join(dirA, 'settings.json')) ?? {}
    expect(first.personalizedSettings).toEqual({ alice: { uiLang: 'zh', theme: 'dark' } })
  })

  it('keeps state.json beside the override so the whole config dir moves together', () => {
    const file = join(dirA, 'nested', 'settings.json')
    setSettingsPath(file)
    expect(c3HomeDir()).toBe(dirname(file))
  })
})
