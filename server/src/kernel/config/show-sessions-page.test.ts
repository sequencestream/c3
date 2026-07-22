import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, resetSettingsCacheForTests, saveSettings, setSettingsPath } from './index.js'

let tempDir: string
let settingsFile: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'c3-show-sessions-page-'))
  settingsFile = join(tempDir, 'settings.json')
  setSettingsPath(settingsFile)
  resetSettingsCacheForTests()
})

afterEach(() => {
  resetSettingsCacheForTests()
  rmSync(tempDir, { recursive: true, force: true })
})

function loadRaw(raw: Record<string, unknown>) {
  writeFileSync(settingsFile, JSON.stringify(raw))
  resetSettingsCacheForTests()
  return loadSettings()
}

describe('SystemSettings.showSessionsPage', () => {
  it.each([
    [{}, false],
    [{ showSessionsPage: false }, false],
    [{ showSessionsPage: true }, true],
    [{ showSessionsPage: 'true' }, false],
  ])('normalizes %j to %s', (raw, expected) => {
    expect(loadRaw(raw).showSessionsPage).toBe(expected)
  })

  it('round-trips independently from showToolSessions', () => {
    const normalized = loadRaw({ showSessionsPage: true, showToolSessions: false })
    saveSettings(normalized)

    const disk = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
    expect(disk.showSessionsPage).toBe(true)
    expect(disk.showToolSessions).toBe(false)
    expect(loadSettings().showSessionsPage).toBe(true)
  })
})
