import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, saveSettings } from './index.js'
import {
  readStoredSystemSettings,
  releaseConfigDb,
  seedSystemSettings,
  useConfigDb,
} from './config-fixture.js'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'c3-show-sessions-page-'))
  useConfigDb(tempDir)
})

afterEach(() => {
  releaseConfigDb()
  rmSync(tempDir, { recursive: true, force: true })
})

function loadRaw(raw: Record<string, unknown>) {
  seedSystemSettings(raw)
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

    const stored = readStoredSystemSettings()
    expect(stored.showSessionsPage).toBe(true)
    expect(stored.showToolSessions).toBe(false)
    expect(loadSettings().showSessionsPage).toBe(true)
  })
})
