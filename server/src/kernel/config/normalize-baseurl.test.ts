/**
 * Unit tests for the SystemSettings.baseUrl normalize rules:
 * - Trims whitespace.
 * - Strips trailing slashes (one or many).
 * - Empty / absent / non-string ⇒ omitted (optional semantics).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, setSettingsPath, resetSettingsCacheForTests } from './index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'c3-baseurl-test-'))
})

afterEach(() => {
  resetSettingsCacheForTests()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Write a minimal valid settings.json and load it. */
function loadWith(raw: Record<string, unknown>) {
  const file = join(tmpDir, 'settings.json')
  writeFileSync(file, JSON.stringify(raw))
  setSettingsPath(file)
  resetSettingsCacheForTests()
  return loadSettings()
}

describe('SystemSettings.baseUrl normalization', () => {
  it('preserves a clean URL', () => {
    const s = loadWith({ baseUrl: 'http://192.168.10.10:9000' })
    expect(s.baseUrl).toBe('http://192.168.10.10:9000')
  })

  it('strips a single trailing slash', () => {
    const s = loadWith({ baseUrl: 'http://192.168.10.10:9000/' })
    expect(s.baseUrl).toBe('http://192.168.10.10:9000')
  })

  it('strips multiple trailing slashes', () => {
    const s = loadWith({ baseUrl: 'http://192.168.10.10:9000///' })
    expect(s.baseUrl).toBe('http://192.168.10.10:9000')
  })

  it('trims leading and trailing whitespace', () => {
    const s = loadWith({ baseUrl: '  http://host:3000  ' })
    expect(s.baseUrl).toBe('http://host:3000')
  })

  it('trims then strips trailing slashes', () => {
    const s = loadWith({ baseUrl: '  http://host:3000/  ' })
    expect(s.baseUrl).toBe('http://host:3000')
  })

  it('omits baseUrl when input is empty string', () => {
    const s = loadWith({ baseUrl: '' })
    expect(s.baseUrl).toBeUndefined()
  })

  it('omits baseUrl when input is whitespace only', () => {
    const s = loadWith({ baseUrl: '   ' })
    expect(s.baseUrl).toBeUndefined()
  })

  it('omits baseUrl when field is absent', () => {
    const s = loadWith({})
    expect(s.baseUrl).toBeUndefined()
  })

  it('omits baseUrl when input is not a string', () => {
    const s = loadWith({ baseUrl: 123 })
    expect(s.baseUrl).toBeUndefined()
  })

  it('omits baseUrl when input is null', () => {
    const s = loadWith({ baseUrl: null })
    expect(s.baseUrl).toBeUndefined()
  })
})
