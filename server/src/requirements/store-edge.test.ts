/**
 * Integration tests for requirement store edge cases NOT already covered by
 * store.test.ts (which owns basic CRUD, deps, status filter, comm mapping, hidden
 * set). Here: db-unavailable degradation, terminal status transitions
 * (done/cancelled), the data shape that `start_development` eligibility +
 * unfinished-dependency warning reason over, and hidden-filter resolve-key
 * consistency. These map to US-5..US-8 acceptance criteria.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resetDbForTests } from './db.js'
import {
  getRequirement,
  insertRequirements,
  isHiddenSession,
  isStoreAvailable,
  listHiddenSessions,
  listRequirements,
  resetStoreForTests,
  setChatSession,
  setLastDevSession,
  updateStatus,
} from './store.js'

const proj = '/abs/edge-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-edge-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('store degradation when db is unavailable', () => {
  beforeEach(() => {
    // Re-point at an unopenable path AFTER the default beforeEach so this block
    // runs against a "broken" db.
    resetDbForTests()
    resetStoreForTests()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
  })

  it('reports unavailable and reads return empty (no throw)', () => {
    // Design §2.1 / §4.8: callers degrade — list/getRequirement/hidden reads must
    // return empty/false/null rather than crash, so c3 keeps running.
    expect(isStoreAvailable()).toBe(false)
    expect(listRequirements(proj)).toEqual([])
    expect(getRequirement('any')).toBeNull()
    expect(listHiddenSessions(proj)).toEqual([])
    expect(isHiddenSession('any')).toBe(false)
  })

  it('writes throw (the save-tool turns this into isError)', () => {
    // A write against a missing db throws; the save_requirements handler catches
    // it and returns isError so the agent learns the save did not happen.
    expect(() => insertRequirements(proj, [{ title: 'X', content: '', priority: 'P0' }])).toThrow()
  })
})

describe('terminal status transitions (US-4 §6)', () => {
  it('moves a requirement to done and to cancelled (never auto, only via update)', () => {
    // §6 / AC: dev completion does NOT auto-set status; the user marks done/cancelled.
    const [a, b] = insertRequirements(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P1' },
    ])
    updateStatus(a.id, 'done')
    updateStatus(b.id, 'cancelled')
    expect(getRequirement(a.id)?.status).toBe('done')
    expect(getRequirement(b.id)?.status).toBe('cancelled')
    // Filters surface them under their new status only.
    expect(listRequirements(proj, 'done').map((r) => r.id)).toEqual([a.id])
    expect(listRequirements(proj, 'cancelled').map((r) => r.id)).toEqual([b.id])
    expect(listRequirements(proj, 'todo')).toEqual([])
  })
})

describe('start_development eligibility data (US-6 §4.6)', () => {
  it('a fresh requirement is todo with no dev session (eligible)', () => {
    // §4.6 step 1: `todo` is the eligible state; lastDevSessionId starts null.
    const [r] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    const got = getRequirement(r.id)!
    expect(got.status).toBe('todo')
    expect(got.lastDevSessionId).toBeNull()
  })

  it('records lastDevSessionId + in_progress on launch; later a dangling dev id stays readable', () => {
    // §4.6 / §4.7: launching dev records the session id and flips to in_progress;
    // the back-link reads lastDevSessionId even if that session was later deleted
    // (the dangling-restart rule then re-checks existence via sessionExists, which
    // is e2e territory). Here we assert the store side the rule reads.
    const [r] = insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    setLastDevSession(r.id, 'dev-sess-1')
    updateStatus(r.id, 'in_progress')
    const got = getRequirement(r.id)!
    expect(got.status).toBe('in_progress')
    expect(got.lastDevSessionId).toBe('dev-sess-1')
  })
})

describe('unfinished-dependency detection (US-8 §4.6 step 2)', () => {
  it('lets a caller see which deps are not yet done', () => {
    // AC-8.2/8.3: start_development warns (not blocks) when a dep's status != done.
    // The store gives callers everything to compute that: dependsOn + each dep's
    // status. Reproduce the check the server/front-end performs.
    const [depDone, depOpen] = insertRequirements(proj, [
      { title: 'dep-done', content: '', priority: 'P0' },
      { title: 'dep-open', content: '', priority: 'P0' },
    ])
    updateStatus(depDone.id, 'done')
    const [target] = insertRequirements(proj, [
      { title: 'feature', content: '', priority: 'P1', dependsOn: [depDone.id, depOpen.id] },
    ])

    const t = getRequirement(target.id)!
    const byId = new Map(listRequirements(proj).map((r) => [r.id, r]))
    const unfinished = t.dependsOn.filter((id) => byId.get(id)?.status !== 'done')
    expect(unfinished).toEqual([depOpen.id])

    // After the open dep is marked done, there are no unfinished deps.
    updateStatus(depOpen.id, 'done')
    const after = new Map(listRequirements(proj).map((r) => [r.id, r]))
    expect(t.dependsOn.filter((id) => after.get(id)?.status !== 'done')).toEqual([])
  })

  it('treats a dangling dep id (deleted requirement) as unfinished', () => {
    // Defensive: a dependsOn pointing at a non-existent requirement (e.g. proposed
    // before its dep existed) is not `done`, so it surfaces in the warning set.
    const [target] = insertRequirements(proj, [
      { title: 'feature', content: '', priority: 'P0', dependsOn: ['ghost-id'] },
    ])
    const t = getRequirement(target.id)!
    const byId = new Map(listRequirements(proj).map((r) => [r.id, r]))
    const unfinished = t.dependsOn.filter((id) => byId.get(id)?.status !== 'done')
    expect(unfinished).toEqual(['ghost-id'])
  })
})

describe('hidden-filter resolve-key consistency (US-3 AC-3.4 §4.8)', () => {
  it('hides a comm session under both the raw and trailing-slash project key', () => {
    // §4.8: listWorkspaceSessions filters with resolve(dir); the store keys
    // requirement_chats by resolve(projectPath). A trailing slash must resolve to
    // the same key so the hidden set is found regardless of how the path is spelled.
    setChatSession(proj, 'comm-1')
    expect(listHiddenSessions(proj)).toEqual(['comm-1'])
    expect(listHiddenSessions(`${proj}/`)).toEqual(['comm-1'])
    expect(resolve(proj)).toBe(resolve(`${proj}/`))
    expect(isHiddenSession('comm-1')).toBe(true)
  })
})
