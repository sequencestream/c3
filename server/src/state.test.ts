import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from './kernel/infra/db.js'
import { resetConfigStoreForTests } from './kernel/config/config-store.js'
import { resetLegacyImportForTests } from './kernel/config/import-legacy.js'
import {
  addWorkspace,
  deleteSessionMode,
  getActiveSessionId,
  getSessionMode,
  hasWorkspace,
  hasWorkspaceName,
  listWorkspaces,
  removeWorkspace,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
  pathToName,
  setActiveSessionId,
  setSessionMode,
  touchWorkspace,
} from './state.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-state-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetConfigStoreForTests()
  resetLegacyImportForTests()
  resetStateCacheForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('workspace registry', () => {
  it('rejects a non-directory and registers an existing one', () => {
    expect(addWorkspace(join(dir, 'nope'), 1)).toBeNull()
    expect(addWorkspace(dir, 1)).toBe(dir)
    expect(hasWorkspace(dir)).toBe(true)
    expect(listWorkspaces()).toHaveLength(1)
    expect(listWorkspaces()[0].name).toBe(dir.split('/').pop())
  })

  it('rejects forged workspace names', () => {
    expect(resolveWorkspaceRoot('does-not-exist')).toBeNull()
    expect(hasWorkspaceName('does-not-exist')).toBe(false)
  })

  it('persists an explicit immutable workspace name', () => {
    addWorkspace(dir, '研发 工作区', 1)
    const ws = listWorkspaces()
    expect(ws).toHaveLength(1)
    expect(ws[0].name).toBe('研发 工作区')
    // path↔name round-trip
    expect(pathToName(dir)).toBe(ws[0].name)
    expect(resolveWorkspaceRoot(ws[0].name)).toBe(dir)
    // path is carried on the wire type for display (still not an identity field)
    expect(ws[0].path).toBe(dir)
  })

  it('is idempotent and orders by most-recent access', () => {
    const a = mkdtempSync(join(tmpdir(), 'c3-a-'))
    const b = mkdtempSync(join(tmpdir(), 'c3-b-'))
    const aName = addWorkspace(a, 10) && pathToName(a)!
    addWorkspace(b, 20)
    expect(resolveWorkspaceRoot(listWorkspaces()[0].name)).toBe(b)
    expect(resolveWorkspaceRoot(listWorkspaces()[1].name)).toBe(a)
    touchWorkspace(a, 30)
    expect(resolveWorkspaceRoot(listWorkspaces()[0].name)).toBe(a)
    expect(resolveWorkspaceRoot(listWorkspaces()[1].name)).toBe(b)
    addWorkspace(a, 40) // re-add bumps, does not duplicate
    expect(listWorkspaces()).toHaveLength(2)
    // re-add does not change name
    expect(pathToName(a)).toBe(aName)
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  it('removeWorkspace drops it without touching sessions', () => {
    addWorkspace(dir, 1)
    removeWorkspace(dir)
    expect(hasWorkspace(dir)).toBe(false)
  })
})

describe('per-session mode & active session', () => {
  it('defaults to default and persists overrides', () => {
    expect(getSessionMode('s1')).toBe('default')
    setSessionMode('s1', 'acceptEdits')
    setSessionMode('s2', 'plan')
    expect(getSessionMode('s1')).toBe('acceptEdits')
    expect(getSessionMode('s2')).toBe('plan')
    deleteSessionMode('s1')
    expect(getSessionMode('s1')).toBe('default')
  })

  it('tracks the active session', () => {
    expect(getActiveSessionId()).toBeNull()
    setActiveSessionId('s9')
    expect(getActiveSessionId()).toBe('s9')
  })
})

describe('persistence across cache reset', () => {
  it('reloads state written to disk', () => {
    addWorkspace(dir, 5)
    setSessionMode('s1', 'plan')
    setActiveSessionId('s1')
    resetStateCacheForTests() // forces re-read from state.json
    expect(hasWorkspace(dir)).toBe(true)
    expect(getSessionMode('s1')).toBe('plan')
    expect(getActiveSessionId()).toBe('s1')
  })
})
