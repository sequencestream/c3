/**
 * `intents` PR review / fix status columns — schema idempotency, historic-row
 * defaults, read narrowing, and the atomic `updateIntentReviewFixStatus` write
 * path. The two phases (review vs fix) must never clobber each other, a terminal
 * write must leave spec approval / completion / impact level / PRs untouched, and
 * an illegal enum / round value must throw with the row unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IntentFixStatus, IntentReviewStatus } from '@ccc/shared/protocol'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces are
// unregistered, so resolve/pathToName/workspaceNameFor would otherwise return null.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  getIntent,
  insertIntents,
  listIntents,
  resetStoreForTests,
  setSpecApproved,
  updateIntentReviewFixStatus,
  updateStatus,
  upsertIntentPr,
} from './store.js'

const proj = '/abs/review-fix-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-review-fix-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function seedIntent(): string {
  const [intent] = insertIntents(proj, [
    { title: '目标意图', shortEnTitle: 'auto', content: '正文', priority: 'P1' },
  ])
  return intent.id
}

describe('PR review/fix columns — schema + historic rows', () => {
  it('declares the five columns on a fresh db with the right nullability and CHECKs', () => {
    listIntents(proj)
    const raw = getDb()!
    const cols = raw
      .all<{ name: string; notnull: number; dflt_value: string | null }>(
        'PRAGMA table_info(intents)',
      )
      .filter((c) =>
        [
          'review_session_id',
          'review_status',
          'review_fix_rounds',
          'fix_session_id',
          'fix_status',
        ].includes(c.name),
      )
    const byName = new Map(cols.map((c) => [c.name, c]))
    expect(byName.size).toBe(5)

    // Session ids and statuses are nullable TEXT without a default: "unreviewed"
    // and "never fixed" are real readings, never fabricated by a default.
    for (const name of ['review_session_id', 'review_status', 'fix_session_id', 'fix_status']) {
      const col = byName.get(name)!
      expect(col.notnull, name).toBe(0)
      expect(col.dflt_value, name).toBeNull()
    }
    // The round counter is NOT NULL with a 0 default (0 = unreviewed / first review).
    expect(byName.get('review_fix_rounds')!.notnull).toBe(1)
    expect(byName.get('review_fix_rounds')!.dflt_value).toBe('0')

    expect(raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(25)
  })

  it('rejects an illegal persisted review/fix status at the CHECK on a fresh db', () => {
    listIntents(proj)
    const raw = getDb()!
    const [r] = insertIntents(proj, [
      { title: 'T', shortEnTitle: 't', content: 'x', priority: 'P1' },
    ])
    expect(() => raw.run("UPDATE intents SET review_status='bogus' WHERE id=?", r.id)).toThrow()
    expect(() => raw.run("UPDATE intents SET fix_status='bogus' WHERE id=?", r.id)).toThrow()
  })

  it('adds the columns to an upgraded db and reads its historic rows as unreviewed', () => {
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intents (
        id              TEXT PRIMARY KEY,
        workspace_name  TEXT NOT NULL,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        priority        TEXT NOT NULL,
        status          TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      PRAGMA user_version=24;
    `)
    raw.run(
      'INSERT INTO intents (id, workspace_name, title, content, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      'old-1',
      proj,
      'Legacy',
      'body',
      'P1',
      'todo',
      1,
      1,
    )

    resetStoreForTests()
    const list = listIntents(proj)
    expect(list).toHaveLength(1)
    expect(list[0].reviewSessionId).toBeNull()
    expect(list[0].reviewStatus).toBeNull()
    expect(list[0].reviewFixRounds).toBe(0)
    expect(list[0].fixSessionId).toBeNull()
    expect(list[0].fixStatus).toBeNull()
    expect(raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(25)
  })

  it('narrows an uninterpretable persisted review/fix status to null, never a middle value', () => {
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intents (
        id              TEXT PRIMARY KEY,
        workspace_name  TEXT NOT NULL,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        priority        TEXT NOT NULL,
        review_status   TEXT,
        fix_status      TEXT,
        status          TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      PRAGMA user_version=24;
    `)
    raw.run(
      'INSERT INTO intents (id, workspace_name, title, content, priority, review_status, fix_status, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      'weird-1',
      proj,
      'Legacy',
      'body',
      'P1',
      'bogus-review',
      'bogus-fix',
      'todo',
      1,
      1,
    )

    resetStoreForTests()
    expect(getIntent('weird-1')?.reviewStatus).toBeNull()
    expect(getIntent('weird-1')?.fixStatus).toBeNull()
  })
})

describe('updateIntentReviewFixStatus — write paths', () => {
  it('writes each of the five fields and reads them back', () => {
    const id = seedIntent()
    updateIntentReviewFixStatus(id, {
      reviewSessionId: 'rev-1',
      reviewStatus: 'approved',
      reviewFixRounds: 2,
      fixSessionId: 'fix-1',
      fixStatus: 'fixed',
    })
    const after = getIntent(id)!
    expect(after.reviewSessionId).toBe('rev-1')
    expect(after.reviewStatus).toBe('approved')
    expect(after.reviewFixRounds).toBe(2)
    expect(after.fixSessionId).toBe('fix-1')
    expect(after.fixStatus).toBe('fixed')
  })

  it('an omitted key leaves the column untouched, an explicit null clears it', () => {
    const id = seedIntent()
    updateIntentReviewFixStatus(id, { reviewSessionId: 'rev-1', reviewStatus: 'rejected' })

    // Omitted fixSessionId / fixStatus stay null (never written).
    expect(getIntent(id)!.fixSessionId).toBeNull()
    expect(getIntent(id)!.fixStatus).toBeNull()

    // Explicit null clears the review session back to "unbound".
    updateIntentReviewFixStatus(id, { reviewSessionId: null })
    expect(getIntent(id)!.reviewSessionId).toBeNull()
    // reviewStatus survives an unrelated reviewSessionId clear.
    expect(getIntent(id)!.reviewStatus).toBe('rejected')
  })

  it('a review write never touches the fix phase, and vice-versa', () => {
    const id = seedIntent()
    updateIntentReviewFixStatus(id, { fixSessionId: 'fix-1', fixStatus: 'fixed' })
    updateIntentReviewFixStatus(id, { reviewSessionId: 'rev-1', reviewStatus: 'approved' })

    const after = getIntent(id)!
    expect(after.reviewSessionId).toBe('rev-1')
    expect(after.reviewStatus).toBe('approved')
    expect(after.fixSessionId).toBe('fix-1')
    expect(after.fixStatus).toBe('fixed')

    // Now a fix write must not clear the review conclusion.
    updateIntentReviewFixStatus(id, { fixStatus: 'fixed', fixSessionId: 'fix-2' })
    expect(getIntent(id)!.reviewSessionId).toBe('rev-1')
    expect(getIntent(id)!.reviewStatus).toBe('approved')
  })

  it('a terminal write never touches spec approval, completion, impact level, PRs, or the round counter', () => {
    const [r] = insertIntents(proj, [
      { title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P1', impactLevel: 'L3' },
    ])
    const id = r.id
    setSpecApproved(id, true, 'alice')
    updateStatus(id, 'done')
    upsertIntentPr({
      intentId: id,
      number: '42',
      status: 'reviewing',
      forge: 'github',
      repo: 'o/r',
      url: 'https://x/pull/42',
    })
    updateIntentReviewFixStatus(id, { fixSessionId: 'fix-1', fixStatus: 'fixed' })

    const updated = updateIntentReviewFixStatus(id, {
      reviewSessionId: 'rev-1',
      reviewStatus: 'rejected',
    })

    expect(updated.reviewStatus).toBe('rejected')
    expect(updated.reviewFixRounds).toBe(0) // sync writes never increment rounds
    expect(updated.fixSessionId).toBe('fix-1') // fix phase untouched
    expect(updated.fixStatus).toBe('fixed')
    expect(updated.specApproved).toBe(true)
    expect(updated.specStatus).toBe('approved')
    expect(updated.status).toBe('done')
    expect(updated.completedAt).not.toBeNull()
    expect(updated.impactLevel).toBe('L3')
    expect(updated.prs).toHaveLength(1)
    expect(updated.prs[0].number).toBe('42')
    expect(updated.prs[0].status).toBe('reviewing')
  })
})

describe('updateIntentReviewFixStatus — rejection', () => {
  it('throws on an illegal review status and leaves the row untouched', () => {
    const id = seedIntent()
    expect(() =>
      updateIntentReviewFixStatus(id, {
        reviewStatus: 'bogus' as IntentReviewStatus,
      }),
    ).toThrow(/非法评审状态/)
    expect(getIntent(id)!.reviewStatus).toBeNull()
  })

  it('throws on an illegal fix status and leaves the row untouched', () => {
    const id = seedIntent()
    expect(() =>
      updateIntentReviewFixStatus(id, { fixStatus: 'bogus' as IntentFixStatus }),
    ).toThrow(/非法修复状态/)
    expect(getIntent(id)!.fixStatus).toBeNull()
  })

  it('throws on a non-integer or negative round count', () => {
    const id = seedIntent()
    expect(() => updateIntentReviewFixStatus(id, { reviewFixRounds: 1.5 })).toThrow(/非法复审轮次/)
    expect(() => updateIntentReviewFixStatus(id, { reviewFixRounds: -1 })).toThrow(/非法复审轮次/)
    expect(getIntent(id)!.reviewFixRounds).toBe(0)
  })

  it('throws on an unknown intent id and writes nothing', () => {
    expect(() =>
      updateIntentReviewFixStatus('no-such-intent', { reviewStatus: 'approved' }),
    ).toThrow(/不存在/)
  })
})
