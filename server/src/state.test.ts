import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addWorkspace,
  deleteSessionMode,
  getActiveSessionId,
  getSessionMode,
  hasWorkspace,
  hasWorkspaceId,
  listWorkspaces,
  removeWorkspace,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
  pathToId,
  setActiveSessionId,
  setSessionMode,
  touchWorkspace,
} from './state.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-state-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetStateCacheForTests()
})

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
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

  it('rejects forged workspace ids', () => {
    expect(resolveWorkspaceRoot('does-not-exist')).toBeNull()
    expect(hasWorkspaceId('does-not-exist')).toBe(false)
  })

  it('assigns and persists opaque ids', () => {
    addWorkspace(dir, 1)
    const ws = listWorkspaces()
    expect(ws).toHaveLength(1)
    expect(ws[0].id).toBeDefined()
    expect(typeof ws[0].id).toBe('string')
    expect(ws[0].id.length).toBeGreaterThan(10)
    // path↔id round-trip
    expect(pathToId(dir)).toBe(ws[0].id)
    expect(resolveWorkspaceRoot(ws[0].id)).toBe(dir)
    // no path on wire type
    expect((ws[0] as unknown as Record<string, unknown>).path).toBeUndefined()
  })

  it('is idempotent and orders by most-recent access', () => {
    const a = mkdtempSync(join(tmpdir(), 'c3-a-'))
    const b = mkdtempSync(join(tmpdir(), 'c3-b-'))
    const aId = addWorkspace(a, 10) && pathToId(a)!
    addWorkspace(b, 20)
    expect(resolveWorkspaceRoot(listWorkspaces()[0].id)).toBe(b)
    expect(resolveWorkspaceRoot(listWorkspaces()[1].id)).toBe(a)
    touchWorkspace(a, 30)
    expect(resolveWorkspaceRoot(listWorkspaces()[0].id)).toBe(a)
    expect(resolveWorkspaceRoot(listWorkspaces()[1].id)).toBe(b)
    addWorkspace(a, 40) // re-add bumps, does not duplicate
    expect(listWorkspaces()).toHaveLength(2)
    // re-add does not change id
    expect(pathToId(a)).toBe(aId)
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
