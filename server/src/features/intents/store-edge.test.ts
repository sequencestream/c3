/**
 * Integration tests for intent store edge cases NOT already covered by
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
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  getIntent,
  insertIntents,
  isHiddenSession,
  isStoreAvailable,
  listHiddenSessions,
  listIntents,
  resetStoreForTests,
  setChatSession,
  setLastDevSession,
  updateStatus,
  upsertIntents,
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
    // Design §2.1 / §4.8: callers degrade — list/getIntent/hidden reads must
    // return empty/false/null rather than crash, so c3 keeps running.
    expect(isStoreAvailable()).toBe(false)
    expect(listIntents(proj)).toEqual([])
    expect(getIntent('any')).toBeNull()
    expect(listHiddenSessions(proj)).toEqual([])
    expect(isHiddenSession('any')).toBe(false)
  })

  it('writes throw (the save-tool turns this into isError)', () => {
    // A write against a missing db throws; the save_intents handler catches
    // it and returns isError so the agent learns the save did not happen.
    expect(() => insertIntents(proj, [{ title: 'X', content: '', priority: 'P0' }])).toThrow()
  })
})

describe('terminal status transitions (US-4 §6)', () => {
  it('moves a intent to done and to cancelled (never auto, only via update)', () => {
    // §6 / AC: dev completion does NOT auto-set status; the user marks done/cancelled.
    const [a, b] = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0' },
      { title: 'B', content: '', priority: 'P1' },
    ])
    updateStatus(a.id, 'done')
    updateStatus(b.id, 'cancelled')
    expect(getIntent(a.id)?.status).toBe('done')
    expect(getIntent(b.id)?.status).toBe('cancelled')
    // Filters surface them under their new status only.
    expect(listIntents(proj, 'done').map((r) => r.id)).toEqual([a.id])
    expect(listIntents(proj, 'cancelled').map((r) => r.id)).toEqual([b.id])
    expect(listIntents(proj, 'todo')).toEqual([])
  })
})

describe('start_development eligibility data (US-6 §4.6)', () => {
  it('a fresh intent is todo with no dev session (eligible)', () => {
    // §4.6 step 1: `todo` is the eligible state; lastDevSessionId starts null.
    const [r] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    const got = getIntent(r.id)!
    expect(got.status).toBe('todo')
    expect(got.lastDevSessionId).toBeNull()
  })

  it('records lastDevSessionId + in_progress on launch; later a dangling dev id stays readable', () => {
    // §4.6 / §4.7: launching dev records the session id and flips to in_progress;
    // the back-link reads lastDevSessionId even if that session was later deleted
    // (the dangling-restart rule then re-checks existence via sessionExists, which
    // is e2e territory). Here we assert the store side the rule reads.
    const [r] = insertIntents(proj, [{ title: 'A', content: '', priority: 'P0' }])
    setLastDevSession(r.id, 'dev-sess-1')
    updateStatus(r.id, 'in_progress')
    const got = getIntent(r.id)!
    expect(got.status).toBe('in_progress')
    expect(got.lastDevSessionId).toBe('dev-sess-1')
  })
})

describe('unfinished-dependency detection (US-8 §4.6 step 2)', () => {
  it('lets a caller see which deps are not yet done', () => {
    // AC-8.2/8.3: start_development warns (not blocks) when a dep's status != done.
    // The store gives callers everything to compute that: dependsOn + each dep's
    // status. Reproduce the check the server/front-end performs.
    const [depDone, depOpen] = insertIntents(proj, [
      { title: 'dep-done', content: '', priority: 'P0' },
      { title: 'dep-open', content: '', priority: 'P0' },
    ])
    updateStatus(depDone.id, 'done')
    const [target] = insertIntents(proj, [
      { title: 'feature', content: '', priority: 'P1', dependsOn: [depDone.id, depOpen.id] },
    ])

    const t = getIntent(target.id)!
    const byId = new Map(listIntents(proj).map((r) => [r.id, r]))
    const unfinished = t.dependsOn.filter((id) => byId.get(id)?.status !== 'done')
    expect(unfinished).toEqual([depOpen.id])

    // After the open dep is marked done, there are no unfinished deps.
    updateStatus(depOpen.id, 'done')
    const after = new Map(listIntents(proj).map((r) => [r.id, r]))
    expect(t.dependsOn.filter((id) => after.get(id)?.status !== 'done')).toEqual([])
  })

  it('treats a dangling dep id (deleted intent) as unfinished', () => {
    // Defensive: a dependsOn pointing at a non-existent intent (e.g. proposed
    // before its dep existed) is not `done`, so it surfaces in the warning set.
    const [target] = insertIntents(proj, [
      { title: 'feature', content: '', priority: 'P0', dependsOn: ['ghost-id'] },
    ])
    const t = getIntent(target.id)!
    const byId = new Map(listIntents(proj).map((r) => [r.id, r]))
    const unfinished = t.dependsOn.filter((id) => byId.get(id)?.status !== 'done')
    expect(unfinished).toEqual(['ghost-id'])
  })
})

describe('upsertIntents — id-keyed update vs insert (RM-R20)', () => {
  it('updates an existing draft/todo intent in place, keeping its status, no new row', () => {
    // AC-1: a batch item carrying a valid id (status todo) updates the original,
    // status unchanged, and inserts nothing new.
    const [r] = insertIntents(proj, [{ title: 'old', content: 'before', priority: 'P2' }])
    const out = upsertIntents(proj, [{ id: r.id, title: 'new', content: 'after', priority: 'P0' }])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(r.id)
    expect(listIntents(proj)).toHaveLength(1) // no new row
    const got = getIntent(r.id)!
    expect(got.title).toBe('new')
    expect(got.content).toBe('after')
    expect(got.priority).toBe('P0')
    expect(got.status).toBe('todo') // unchanged
  })

  it('still inserts when no id is supplied', () => {
    const [r] = insertIntents(proj, [{ title: 'keep', content: '', priority: 'P1' }])
    upsertIntents(proj, [{ title: 'fresh', content: '', priority: 'P0' }])
    expect(
      listIntents(proj)
        .map((x) => x.title)
        .sort(),
    ).toEqual(['fresh', 'keep'])
    expect(getIntent(r.id)!.title).toBe('keep')
  })

  it('reactivates a cancelled intent to todo on update, completed_at stays null', () => {
    // AC-2: cancelled + id → content updated AND status flips to todo (completed_at null).
    const [r] = insertIntents(proj, [{ title: 'c', content: 'x', priority: 'P0' }])
    updateStatus(r.id, 'cancelled')
    upsertIntents(proj, [{ id: r.id, title: 'c2', content: 'y', priority: 'P0' }])
    const got = getIntent(r.id)!
    expect(got.status).toBe('todo')
    expect(got.title).toBe('c2')
    expect(got.completedAt).toBeNull()
  })

  it('rejects the whole batch (no write) when a target is in_progress', () => {
    // AC-3: an in_progress / done target is immutable → throw, nothing persisted.
    const [r] = insertIntents(proj, [{ title: 'locked', content: 'orig', priority: 'P0' }])
    updateStatus(r.id, 'in_progress')
    expect(() =>
      upsertIntents(proj, [
        { id: r.id, title: 'hacked', content: 'no', priority: 'P3' },
        { title: 'sibling', content: '', priority: 'P0' },
      ]),
    ).toThrow(/不可修改/)
    expect(getIntent(r.id)!.title).toBe('locked') // untouched
    expect(listIntents(proj)).toHaveLength(1) // sibling not inserted
  })

  it('rejects the whole batch (no write) when a target is done', () => {
    const [r] = insertIntents(proj, [{ title: 'finished', content: 'orig', priority: 'P0' }])
    updateStatus(r.id, 'done')
    expect(() =>
      upsertIntents(proj, [{ id: r.id, title: 'reopen', content: '', priority: 'P0' }]),
    ).toThrow(/不可修改/)
    expect(getIntent(r.id)!.status).toBe('done')
    expect(getIntent(r.id)!.title).toBe('finished')
  })

  it('rejects an unknown id (no write)', () => {
    // AC-4: an id that resolves to nothing → throw, nothing persisted.
    expect(() =>
      upsertIntents(proj, [{ id: 'ghost', title: 'x', content: '', priority: 'P0' }]),
    ).toThrow(/不存在/)
    expect(listIntents(proj)).toEqual([])
  })

  it('rejects a cross-project id (no write)', () => {
    // AC-4: an id belonging to ANOTHER project is treated as not-in-this-project.
    const [other] = insertIntents('/abs/other-proj', [
      { title: 'theirs', content: '', priority: 'P0' },
    ])
    expect(() =>
      upsertIntents(proj, [{ id: other.id, title: 'steal', content: '', priority: 'P0' }]),
    ).toThrow(/不存在/)
    expect(getIntent(other.id)!.title).toBe('theirs') // foreign row untouched
    expect(listIntents(proj)).toEqual([])
  })

  it('applies a mixed update+insert batch atomically with intra-batch deps', () => {
    // AC-6: one transaction; an item updates while a new item depends on it by index.
    const [r] = insertIntents(proj, [{ title: 'base', content: '', priority: 'P0' }])
    const out = upsertIntents(proj, [
      { id: r.id, title: 'base2', content: '', priority: 'P0' }, // index 0 = updated row
      { title: 'follower', content: '', priority: 'P1', dependsOnIndexes: [0] }, // new, depends on the update
    ])
    expect(out).toHaveLength(2)
    expect(listIntents(proj)).toHaveLength(2) // base updated (1) + follower inserted (1)
    const follower = listIntents(proj).find((x) => x.title === 'follower')!
    expect(follower.dependsOn).toEqual([r.id])
    expect(getIntent(r.id)!.title).toBe('base2')
  })

  it('rolls the whole batch back when one item fails validation (insert dep cycle)', () => {
    // AC-6: a new item's invalid dependsOnIndexes makes the batch throw; the valid
    // update in the same batch must NOT have been applied.
    const [r] = insertIntents(proj, [{ title: 'orig', content: '', priority: 'P0' }])
    expect(() =>
      upsertIntents(proj, [
        { id: r.id, title: 'updated', content: '', priority: 'P0' },
        { title: 'a', content: '', priority: 'P0', dependsOnIndexes: [2] }, // out of range
      ]),
    ).toThrow()
    expect(getIntent(r.id)!.title).toBe('orig') // update rolled back
    expect(listIntents(proj)).toHaveLength(1)
  })

  it('preserves module and deps when those fields are omitted on update', () => {
    // "未传字段保持原值": omitting module keeps the prior module; omitting both
    // dependsOn/dependsOnIndexes keeps the prior dependency set.
    const [r] = insertIntents(proj, [
      { title: 't', content: '', priority: 'P0', module: 'auth', dependsOn: ['ext'] },
    ])
    upsertIntents(proj, [{ id: r.id, title: 't2', content: 'body', priority: 'P1' }])
    const got = getIntent(r.id)!
    expect(got.module).toBe('auth') // preserved
    expect(got.dependsOn).toEqual(['ext']) // preserved
  })

  it('replaces deps when dependsOn is supplied on update', () => {
    const [dep] = insertIntents(proj, [{ title: 'dep', content: '', priority: 'P0' }])
    const [r] = insertIntents(proj, [
      { title: 't', content: '', priority: 'P0', dependsOn: ['old-ext'] },
    ])
    upsertIntents(proj, [
      { id: r.id, title: 't', content: '', priority: 'P0', dependsOn: [dep.id] },
    ])
    expect(getIntent(r.id)!.dependsOn).toEqual([dep.id]) // replaced, not merged
  })
})

describe('hidden-filter resolve-key consistency (US-3 AC-3.4 §4.8)', () => {
  it('hides a comm session under both the raw and trailing-slash project key', () => {
    // §4.8: listWorkspaceSessions filters with resolve(dir); the store keys
    // intent_chats by resolve(workspacePath). A trailing slash must resolve to
    // the same key so the hidden set is found regardless of how the path is spelled.
    setChatSession(proj, 'comm-1')
    expect(listHiddenSessions(proj)).toEqual(['comm-1'])
    expect(listHiddenSessions(`${proj}/`)).toEqual(['comm-1'])
    expect(resolve(proj)).toBe(resolve(`${proj}/`))
    expect(isHiddenSession('comm-1')).toBe(true)
  })
})
