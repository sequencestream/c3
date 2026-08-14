/**
 * The `intent_prs` table itself: the one-shot backfill out of the frozen legacy
 * columns, the two unique keys plus the partial index that actually enforces
 * "one PR per intent" while `delivery_id` is null, and `upsertIntentPr`'s
 * look-up-then-write semantics.
 *
 * These are the guarantees the rest of the PR code assumes and cannot restate:
 * every read point trusts that a PR exists exactly once and that a status write
 * updates rather than duplicates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import {
  getIntent,
  insertIntents,
  listIntentPrs,
  listReviewingIntentPrs,
  resetStoreForTests,
  upsertIntentPr,
} from './store.js'
import { parsePrIdentity } from './pr-identity.js'

let dir: string
const proj = '/abs/pr-project'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-intent-prs-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  resetStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** A pre-split `intents` table carrying the legacy PR trio, plus the given rows. */
function seedLegacyIntents(
  raw: Db,
  rows: Array<{
    id: string
    prId: string | null
    prUrl?: string | null
    prStatus?: string | null
    branch?: string | null
    updatedAt: number
  }>,
): void {
  raw.exec(`
    CREATE TABLE intents (
      id TEXT PRIMARY KEY, workspace_name TEXT NOT NULL, title TEXT NOT NULL,
      short_en_title TEXT, content TEXT NOT NULL, priority TEXT NOT NULL,
      status TEXT NOT NULL, module TEXT NOT NULL DEFAULT '', last_work_session_id TEXT,
      automate INTEGER NOT NULL DEFAULT 0, branch_name TEXT, latest_commit_hash TEXT,
      pr_id TEXT, pr_url TEXT, pr_status TEXT, spec_path TEXT,
      spec_approved INTEGER NOT NULL DEFAULT 0, spec_approve_user TEXT, spec_session_id TEXT,
      intent_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `)
  for (const r of rows) {
    raw.run(
      `INSERT INTO intents
         (id, workspace_name, title, content, priority, status, branch_name, pr_id, pr_url, pr_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.id,
      proj,
      `T-${r.id}`,
      '',
      'P1',
      'done',
      r.branch ?? null,
      r.prId,
      r.prUrl ?? null,
      r.prStatus ?? null,
      1,
      r.updatedAt,
    )
  }
}

describe('v19 → v20 backfill of the legacy PR columns', () => {
  it('lifts every intent with a pr_id into intent_prs, field by field', () => {
    const raw = getDb()!
    seedLegacyIntents(raw, [
      {
        id: 'gh',
        prId: '42',
        prUrl: 'https://github.com/owner/repo/pull/42',
        prStatus: 'merged',
        branch: 'feat/gh',
        updatedAt: 1_700_000_000_000,
      },
      {
        id: 'gl',
        prId: '7',
        prUrl: 'https://gitlab.example.com/group/sub/proj/-/merge_requests/7',
        prStatus: 'reviewing',
        branch: 'feat/gl',
        updatedAt: 1_700_000_000_000,
      },
    ])

    resetStoreForTests()
    expect(getIntent('gh')?.prs[0]).toMatchObject({
      number: '42',
      url: 'https://github.com/owner/repo/pull/42',
      status: 'merged',
      forge: 'github',
      repo: 'owner/repo',
      headBranch: 'feat/gh',
      // Every legacy PR targeted a literal `main`; the column exists so future
      // rows can say otherwise, not so this one can guess.
      baseBranch: 'main',
      deliveryId: null,
    })
    expect(getIntent('gl')?.prs[0]).toMatchObject({
      number: '7',
      status: 'reviewing',
      forge: 'gitlab',
      repo: 'group/sub/proj',
      headBranch: 'feat/gl',
    })
    // The row count matches the number of intents that had a non-empty pr_id.
    expect(raw.all('SELECT id FROM intent_prs')).toHaveLength(2)
  })

  it('skips rows without a PR identity and normalises unusable statuses', () => {
    const raw = getDb()!
    seedLegacyIntents(raw, [
      // `pr_status='merged'` with no pr_id: no PR identity to carry over. These
      // rows already render as "no PR" in the UI, so dropping them is not a regression.
      { id: 'no-id', prId: null, prStatus: 'merged', updatedAt: 1_700_000_000_000 },
      { id: 'blank-id', prId: '   ', prStatus: 'merged', updatedAt: 1_700_000_000_000 },
      // Empty / unknown status: the row's existence proves the PR exists, so it
      // lands on the syncable non-terminal state instead of being discarded.
      { id: 'no-status', prId: '11', prStatus: null, updatedAt: 1_700_000_000_000 },
      { id: 'bad-status', prId: '12', prStatus: 'queued', updatedAt: 1_700_000_000_000 },
    ])

    resetStoreForTests()
    expect(getIntent('no-id')?.prs).toEqual([])
    expect(getIntent('blank-id')?.prs).toEqual([])
    expect(getIntent('no-status')?.prs[0].status).toBe('reviewing')
    expect(getIntent('bad-status')?.prs[0].status).toBe('reviewing')
  })

  it('normalises 10-digit epoch-second timestamps to epoch-ms', () => {
    const raw = getDb()!
    const epochSeconds = 1_700_000_000 // 10 digits
    seedLegacyIntents(raw, [
      { id: 'secs', prId: '1', updatedAt: epochSeconds },
      { id: 'ms', prId: '2', updatedAt: 1_700_000_000_000 },
    ])

    resetStoreForTests()
    expect(getIntent('secs')?.prs[0].createdAt).toBe(epochSeconds * 1000)
    expect(getIntent('secs')?.prs[0].updatedAt).toBe(epochSeconds * 1000)
    expect(getIntent('ms')?.prs[0].createdAt).toBe(1_700_000_000_000)
  })

  it('is idempotent — a second start does not produce a second batch of rows', () => {
    const raw = getDb()!
    seedLegacyIntents(raw, [
      { id: 'a', prId: '1', updatedAt: 1_700_000_000_000 },
      { id: 'b', prId: '2', updatedAt: 1_700_000_000_000 },
    ])

    resetStoreForTests()
    expect(getIntent('a')?.prs).toHaveLength(1)
    const first = raw
      .all<{ id: string }>('SELECT id FROM intent_prs')
      .map((r) => r.id)
      .sort()

    // Re-arm the once-only schema ensure: this is exactly what a service restart does.
    resetStoreForTests()
    expect(getIntent('a')?.prs).toHaveLength(1)
    expect(
      raw
        .all<{ id: string }>('SELECT id FROM intent_prs')
        .map((r) => r.id)
        .sort(),
    ).toEqual(first)
    expect(
      raw.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE id='intents.backfill_intent_prs.v1'",
      )?.n,
    ).toBe(1)
  })

  it('degrades duplicate PR identities per row instead of rolling back the whole pass', () => {
    const raw = getDb()!
    // Two intents point at the SAME real PR (#7 on owner/repo). The legacy model
    // could not express that and merely stored the pair; the backfill must not
    // let the second INSERT take the whole migration (and the marker) down.
    seedLegacyIntents(raw, [
      {
        id: 'dup-a',
        prId: '7',
        prUrl: 'https://github.com/owner/repo/pull/7',
        prStatus: 'reviewing',
        updatedAt: 1_700_000_000_000,
      },
      {
        id: 'dup-b',
        prId: '7',
        prUrl: 'https://github.com/owner/repo/pull/7',
        prStatus: 'reviewing',
        updatedAt: 1_700_000_000_000,
      },
      // A later, distinct PR must still land after the collision.
      {
        id: 'legit',
        prId: '8',
        prUrl: 'https://github.com/owner/repo/pull/8',
        prStatus: 'reviewing',
        updatedAt: 1_700_000_000_000,
      },
    ])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      resetStoreForTests()
      // The store must initialize despite the duplicate — the migration marker is
      // what unblocks every subsequent start.
      expect(getIntent('legit')?.prs[0].number).toBe('8')

      // The identity is claimed exactly once; the colliding row is skipped.
      expect(
        raw.all<{ intent_id: string }>('SELECT intent_id FROM intent_prs WHERE number=?', '7'),
      ).toHaveLength(1)
      expect(raw.all<{ n: number }>('SELECT COUNT(*) AS n FROM intent_prs')).toEqual([{ n: 2 }])

      // The skipped row warned and the marker landed, so a restart does not re-run.
      expect(warn).toHaveBeenCalledOnce()
      expect(
        raw.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE id='intents.backfill_intent_prs.v1'",
        )?.n,
      ).toBe(1)

      // A second start is a no-op: still exactly one claim of #7, marker present.
      resetStoreForTests()
      expect(getIntent('dup-a')?.prs).toHaveLength(1)
      expect(raw.all<{ n: number }>('SELECT COUNT(*) AS n FROM intent_prs')).toEqual([{ n: 2 }])
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves the legacy columns untouched — they are the rollback script’s landing site', () => {
    const raw = getDb()!
    seedLegacyIntents(raw, [
      {
        id: 'keep',
        prId: '55',
        prUrl: 'https://github.com/o/r/pull/55',
        prStatus: 'reviewing',
        updatedAt: 1_700_000_000_000,
      },
    ])

    resetStoreForTests()
    // A status advance through the new table must not write back to the old columns.
    upsertIntentPr({ intentId: 'keep', number: '55', status: 'merged' })

    expect(raw.get('SELECT pr_id, pr_url, pr_status FROM intents WHERE id=?', 'keep')).toEqual({
      pr_id: '55',
      pr_url: 'https://github.com/o/r/pull/55',
      pr_status: 'reviewing',
    })
  })
})

describe('upsertIntentPr', () => {
  function seedIntent(title: string): string {
    return insertIntents(proj, [{ title, shortEnTitle: 'x', content: '', priority: 'P1' }])[0].id
  }

  it('inserts once, then UPDATES the same row on a repeat write', () => {
    const id = seedIntent('Repeat')
    upsertIntentPr({
      intentId: id,
      number: '9',
      status: 'reviewing',
      forge: 'github',
      repo: 'o/r',
      url: 'https://github.com/o/r/pull/9',
    })
    const first = listIntentPrs(id)[0]

    upsertIntentPr({
      intentId: id,
      number: '9',
      status: 'merged',
      forge: 'github',
      repo: 'o/r',
    })
    const rows = listIntentPrs(id)

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.id) // same row, not a second one
    expect(rows[0].status).toBe('merged')
    // Fields not supplied on the second write survive it; created_at never moves.
    expect(rows[0].url).toBe('https://github.com/o/r/pull/9')
    expect(rows[0].createdAt).toBe(first.createdAt)
  })

  it('finds the existing row even when delivery_id is null (the NULL-comparison trap)', () => {
    const id = seedIntent('NullDelivery')
    // No forge/repo ⇒ the identity lookup cannot run, so this exercises the
    // `delivery_id IS NULL` branch specifically. A plain `= ?` would miss, fall
    // through to an INSERT, and be rejected by the partial unique index.
    upsertIntentPr({ intentId: id, number: '1', status: 'reviewing' })
    expect(() => upsertIntentPr({ intentId: id, number: '2', status: 'reviewing' })).not.toThrow()
    expect(listIntentPrs(id)).toHaveLength(1)
    expect(listIntentPrs(id)[0].number).toBe('2')
  })

  it('refuses to re-hang a real PR onto a different intent', () => {
    const a = seedIntent('Owner')
    const b = seedIntent('Thief')
    upsertIntentPr({ intentId: a, number: '5', status: 'reviewing', forge: 'github', repo: 'o/r' })

    expect(() =>
      upsertIntentPr({
        intentId: b,
        number: '5',
        status: 'reviewing',
        forge: 'github',
        repo: 'o/r',
      }),
    ).toThrow(/已归属意图/)
    // The rejected write leaves both intents exactly as they were.
    expect(listIntentPrs(a)).toHaveLength(1)
    expect(listIntentPrs(b)).toHaveLength(0)
  })

  it('rejects an empty PR number', () => {
    const id = seedIntent('NoNumber')
    expect(() => upsertIntentPr({ intentId: id, number: '  ', status: 'reviewing' })).toThrow()
  })

  it('lists only reviewing rows for the sync pass', () => {
    const a = seedIntent('Reviewing')
    const b = seedIntent('Merged')
    upsertIntentPr({ intentId: a, number: '1', status: 'reviewing' })
    upsertIntentPr({ intentId: b, number: '2', status: 'merged' })

    expect(listReviewingIntentPrs(a).map((pr) => pr.number)).toEqual(['1'])
    expect(listReviewingIntentPrs(b)).toEqual([])
  })
})

describe('unique keys', () => {
  it('the partial index rejects a second delivery-less PR for one intent', () => {
    const raw = getDb()!
    const id = insertIntents(proj, [
      { title: 'Two rows', shortEnTitle: 'x', content: '', priority: 'P1' },
    ])[0].id
    upsertIntentPr({ intentId: id, number: '1', status: 'reviewing' })

    // Deliberately bypasses `upsertIntentPr` (which would have UPDATEd): the point
    // is that the DATABASE holds the invariant even against a direct write.
    // `UNIQUE(intent_id, delivery_id)` alone cannot — SQLite treats NULLs as
    // distinct — so this proves the partial index is what is doing the work.
    expect(() =>
      raw.run(
        `INSERT INTO intent_prs
           (id, intent_id, delivery_id, forge, repo, number, url, status, head_branch, base_branch, created_at, updated_at)
         VALUES (?,?,NULL,NULL,NULL,?,NULL,?,NULL,NULL,?,?)`,
        'forced-row',
        id,
        '2',
        'reviewing',
        1,
        1,
      ),
    ).toThrow()
  })

  it('the identity index rejects the same (forge, repo, number) twice', () => {
    const raw = getDb()!
    const [a, b] = insertIntents(proj, [
      { title: 'A', shortEnTitle: 'a', content: '', priority: 'P1' },
      { title: 'B', shortEnTitle: 'b', content: '', priority: 'P1' },
    ])
    upsertIntentPr({
      intentId: a.id,
      number: '3',
      status: 'reviewing',
      forge: 'github',
      repo: 'o/r',
    })

    expect(() =>
      raw.run(
        `INSERT INTO intent_prs
           (id, intent_id, delivery_id, forge, repo, number, url, status, head_branch, base_branch, created_at, updated_at)
         VALUES (?,?,NULL,'github','o/r',?,NULL,?,NULL,NULL,?,?)`,
        'dup-row',
        b.id,
        '3',
        'reviewing',
        1,
        1,
      ),
    ).toThrow()
  })
})

describe('parsePrIdentity', () => {
  it.each([
    ['https://github.com/owner/repo/pull/42', 'github', 'owner/repo'],
    ['https://gitlab.com/group/proj/-/merge_requests/7', 'gitlab', 'group/proj'],
    ['https://git.corp.example/team/sub/app/-/merge_requests/9', 'gitlab', 'team/sub/app'],
    // Self-hosted GitLab without the `/-/` infix.
    ['https://git.corp.example/team/app/merge_requests/9', 'gitlab', 'team/app'],
  ] as const)('parses %s', (url, forge, repo) => {
    expect(parsePrIdentity(url)).toEqual({ forge, repo })
  })

  it('keeps the forge but leaves the repo unknown when the path shape is unfamiliar', () => {
    // The host is a real fact; the path segments are not something to guess at.
    expect(parsePrIdentity('https://github.com/owner/repo')).toEqual({
      forge: 'github',
      repo: null,
    })
    // No repo segment before the marker.
    expect(parsePrIdentity('https://h/pull/42')).toEqual({ forge: 'gitlab', repo: null })
  })

  it('reads an absent or unparseable URL as "origin unknown"', () => {
    expect(parsePrIdentity(null)).toEqual({ forge: null, repo: null })
    expect(parsePrIdentity('')).toEqual({ forge: null, repo: null })
    expect(parsePrIdentity('not a url')).toEqual({ forge: null, repo: null })
  })
})
