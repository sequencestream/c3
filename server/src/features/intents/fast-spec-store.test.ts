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

  it('re-upserting (resume) refreshes the baseline and re-opens the settleable window', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Turn', shortEnTitle: 'turn', content: '', priority: 'P1' },
    ])
    upsertFastTurnBaseline({
      sessionId: 's2',
      intentId: intent.id,
      workspacePath: proj,
      baseline: { '/abs/repo-a': 'old' },
    })
    // Settle the first turn fully, then resume re-upserts over the same session.
    expect(claimFastTurnSettled('s2')).toBe(true)
    completeFastTurnSettle('s2', 'small', '/new/spec.md')
    upsertFastTurnBaseline({
      sessionId: 's2',
      intentId: intent.id,
      workspacePath: proj,
      baseline: { '/abs/repo-a': 'new' },
    })

    const rec = getFastTurn('s2')!
    expect(JSON.parse(rec.baseline)).toEqual({ '/abs/repo-a': 'new' })
    // The previous turn's settlement markers are cleared — this turn can claim again.
    expect(rec.settledAt).toBeNull()
    expect(rec.outcome).toBeNull()
    expect(rec.specPath).toBeNull()
  })

  it('same session: first settle → resume re-baseline → second turn claims and settles again', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Turn', shortEnTitle: 'turn', content: '', priority: 'P1' },
    ])
    const sessionId = 's-resume'

    // Turn 1: baseline → settle (small) → complete.
    upsertFastTurnBaseline({
      sessionId,
      intentId: intent.id,
      workspacePath: proj,
      baseline: { '/abs/repo-a': 'old' },
    })
    expect(claimFastTurnSettled(sessionId)).toBe(true)
    completeFastTurnSettle(sessionId, 'small', '/new/spec.md')
    let rec = getFastTurn(sessionId)!
    expect(rec.settledAt).not.toBeNull()
    expect(rec.outcome).toBe('small')

    // Turn 2 (resume, same session): re-baseline opens a new settleable window.
    upsertFastTurnBaseline({
      sessionId,
      intentId: intent.id,
      workspacePath: proj,
      baseline: { '/abs/repo-a': 'new' },
    })
    rec = getFastTurn(sessionId)!
    expect(JSON.parse(rec.baseline)).toEqual({ '/abs/repo-a': 'new' })
    expect(rec.settledAt).toBeNull()
    expect(rec.outcome).toBeNull()
    expect(rec.specPath).toBeNull()

    // The second turn claims and settles independently of the first turn's record.
    expect(claimFastTurnSettled(sessionId)).toBe(true)
    expect(claimFastTurnSettled(sessionId)).toBe(false) // still idempotent within THIS turn
    completeFastTurnSettle(sessionId, 'over')
    rec = getFastTurn(sessionId)!
    expect(rec.outcome).toBe('over')
  })
})
