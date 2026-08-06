/**
 * Tests for the fast-spec store layer: the per-intent spec-mode override and the
 * per-turn settlement record (baseline + idempotency). Uses a real temp DB,
 * mirroring `store.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  claimFastTurnSettled,
  completeFastTurnSettle,
  getFastTurn,
  getIntent,
  insertIntents,
  resetStoreForTests,
  setReverseSpec,
  setSpecApproved,
  setSpecMode,
  setSpecPath,
  switchFastIntentToSdd,
  upsertFastTurnBaseline,
} from './store.js'

let dir: string
const proj = '/abs/project-a'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-fast-store-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('per-intent spec-mode override', () => {
  it('setSpecMode persists and clears the override', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Mode', shortEnTitle: 'mode', content: '', priority: 'P1' },
    ])
    expect(getIntent(intent.id)!.specMode).toBeNull()

    setSpecMode(intent.id, 'fast')
    expect(getIntent(intent.id)!.specMode).toBe('fast')

    setSpecMode(intent.id, null)
    expect(getIntent(intent.id)!.specMode).toBeNull()
  })

  it('switchFastIntentToSdd pins an unset or fast intent to explicit sdd, leaves explicit sdd alone', () => {
    const [fast] = insertIntents(proj, [
      { title: 'Fast', shortEnTitle: 'fast', content: '', priority: 'P1', specMode: 'fast' },
    ])
    expect(switchFastIntentToSdd(fast.id)).toBe(true)
    expect(getIntent(fast.id)!.specMode).toBe('sdd')
    // Now explicit `sdd` — a second switch is a no-op (a concurrent user action
    // must never be clobbered).
    expect(switchFastIntentToSdd(fast.id)).toBe(false)

    const [unset] = insertIntents(proj, [
      { title: 'Unset', shortEnTitle: 'unset', content: '', priority: 'P1' },
    ])
    expect(switchFastIntentToSdd(unset.id)).toBe(true)
    expect(getIntent(unset.id)!.specMode).toBe('sdd')
  })

  it('setReverseSpec lands the new path as pending and clears stale approval facts', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Spec', shortEnTitle: 'spec', content: '', priority: 'P1' },
    ])
    setSpecPath(intent.id, '/old/spec.md')
    setSpecApproved(intent.id, true, 'admin')

    setReverseSpec(intent.id, '/new/spec.md')

    const i = getIntent(intent.id)!
    expect(i.specPath).toBe('/new/spec.md')
    expect(i.specStatus).toBe('pending')
    expect(i.specApproved).toBe(false)
    expect(i.specApproveUser).toBeNull()
  })
})

describe('fast-turn settlement record', () => {
  it('upserts, reads, claims exactly once and records the outcome', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Turn', shortEnTitle: 'turn', content: '', priority: 'P1' },
    ])
    upsertFastTurnBaseline({
      sessionId: 's1',
      intentId: intent.id,
      workspacePath: proj,
      baseline: { '/abs/repo-a': 'abc123' },
    })

    const before = getFastTurn('s1')!
    expect(before.intentId).toBe(intent.id)
    expect(before.outcome).toBeNull()
    expect(JSON.parse(before.baseline)).toEqual({ '/abs/repo-a': 'abc123' })

    expect(claimFastTurnSettled('s1')).toBe(true)
    expect(claimFastTurnSettled('s1')).toBe(false) // idempotent — a replay no-ops

    completeFastTurnSettle('s1', 'small', '/new/spec.md')
    const after = getFastTurn('s1')!
    expect(after.outcome).toBe('small')
    expect(after.specPath).toBe('/new/spec.md')
  })

  it('re-upserting refreshes the baseline only', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Turn', shortEnTitle: 'turn', content: '', priority: 'P1' },
    ])
    upsertFastTurnBaseline({
      sessionId: 's2',
      intentId: intent.id,
      workspacePath: proj,
      baseline: { '/abs/repo-a': 'old' },
    })
    upsertFastTurnBaseline({
      sessionId: 's2',
      intentId: intent.id,
      workspacePath: proj,
      baseline: { '/abs/repo-a': 'new' },
    })

    expect(JSON.parse(getFastTurn('s2')!.baseline)).toEqual({ '/abs/repo-a': 'new' })
  })
})
