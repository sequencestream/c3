import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from './db.js'
import {
  getChatSession,
  getRequirement,
  insertRequirements,
  isHiddenSession,
  isStoreAvailable,
  listHiddenSessions,
  listRequirements,
  rebindChatSession,
  resetStoreForTests,
  setChatSession,
  setLastDevSession,
  updateRequirement,
  updateStatus,
} from './store.js'

let dir: string
const proj = '/abs/project-a'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-db-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('requirements CRUD', () => {
  it('inserts a batch as todo and lists with dependsOn, in insertion order', () => {
    expect(isStoreAvailable()).toBe(true)
    const saved = insertRequirements(proj, [
      { title: 'A', content: 'ca', priority: 'P1' },
      { title: 'B', content: 'cb', priority: 'P0', dependsOn: ['x', 'y'] },
    ])
    expect(saved).toHaveLength(2)
    expect(saved[0].title).toBe('A')
    expect(saved[0].status).toBe('todo')
    expect(saved[0].dependsOn).toEqual([])
    expect(saved[1].dependsOn.sort()).toEqual(['x', 'y'])
    expect(saved[1].lastDevSessionId).toBeNull()
    // listed sorted by priority asc then recency — B (P0) before A (P1)
    const list = listRequirements(proj)
    expect(list.map((r) => r.title)).toEqual(['B', 'A'])
  })

  it('filters by status', () => {
    const [a] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P2' }])
    insertRequirements(proj, [{ title: 'B', content: '', priority: 'P2' }])
    updateStatus(a.id, 'in_progress')
    expect(listRequirements(proj, 'todo').map((r) => r.title)).toEqual(['B'])
    expect(listRequirements(proj, 'in_progress').map((r) => r.title)).toEqual(['A'])
  })

  it('scopes by project', () => {
    insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    insertRequirements('/abs/project-b', [{ title: 'B', content: '', priority: 'P0' }])
    expect(listRequirements(proj).map((r) => r.title)).toEqual(['A'])
    expect(listRequirements('/abs/project-b').map((r) => r.title)).toEqual(['B'])
  })

  it('normalizes project paths (resolve)', () => {
    insertRequirements('/abs/project-a/', [{ title: 'A', content: '', priority: 'P0' }])
    // trailing slash resolves to the same key
    expect(listRequirements('/abs/project-a').map((r) => r.title)).toEqual(['A'])
  })

  it('records last dev session and updates status', () => {
    const [r] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    setLastDevSession(r.id, 'sess-123')
    updateStatus(r.id, 'in_progress')
    const got = getRequirement(r.id)
    expect(got?.lastDevSessionId).toBe('sess-123')
    expect(got?.status).toBe('in_progress')
  })

  it('patches fields and replaces dependencies', () => {
    const [r] = insertRequirements(proj, [
      { title: 'A', content: 'old', priority: 'P2', dependsOn: ['x'] },
    ])
    updateRequirement(r.id, { content: 'new', priority: 'P0', dependsOn: ['y', 'z'] })
    const got = getRequirement(r.id)
    expect(got?.content).toBe('new')
    expect(got?.priority).toBe('P0')
    expect(got?.dependsOn.sort()).toEqual(['y', 'z'])
    expect(got?.title).toBe('A') // untouched
  })

  it('persists across a cache reset (real file)', () => {
    const [r] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    resetDbForTests()
    resetStoreForTests()
    expect(getRequirement(r.id)?.title).toBe('A')
  })
})

describe('communication session mapping / hidden set', () => {
  it('tracks one current session per project and switches it', () => {
    setChatSession(proj, 's1')
    expect(getChatSession(proj)).toBe('s1')
    setChatSession(proj, 's2')
    expect(getChatSession(proj)).toBe('s2')
    // both ids stay in the hidden set even though only s2 is current
    expect(listHiddenSessions(proj).sort()).toEqual(['s1', 's2'])
    expect(isHiddenSession('s1')).toBe(true)
    expect(isHiddenSession('s2')).toBe(true)
    expect(isHiddenSession('other')).toBe(false)
  })

  it('rebinds a pending session id to the real one, keeping current + hidden', () => {
    setChatSession(proj, 'pending:abc')
    rebindChatSession('pending:abc', 'real-xyz')
    expect(getChatSession(proj)).toBe('real-xyz')
    expect(isHiddenSession('pending:abc')).toBe(false)
    expect(isHiddenSession('real-xyz')).toBe(true)
  })

  it('keeps hidden sets project-scoped', () => {
    setChatSession(proj, 's1')
    setChatSession('/abs/project-b', 's2')
    expect(listHiddenSessions(proj)).toEqual(['s1'])
    expect(listHiddenSessions('/abs/project-b')).toEqual(['s2'])
  })
})
