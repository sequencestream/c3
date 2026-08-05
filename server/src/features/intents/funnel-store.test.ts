/**
 * The park funnel table and the recovery figures derived from it, over a real
 * (temp-file) sqlite database.
 *
 * Two things are being protected here. The first is the privacy boundary: six
 * columns, closed enums, and a write path that refuses anything else — the table
 * must be structurally incapable of holding prose, so it can never be quietly
 * repurposed as telemetry. The second is that the numbers mean what the panel
 * says they mean: immature samples do not drag the ratio down, an empty
 * denominator is "not enough samples" rather than 0%, workspaces do not bleed
 * into each other, and the retention horizon holds on both the read and the
 * write path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { deleteQueueIntentMeta, resetQueueStoreForTests } from './queue-store.js'
import {
  FUNNEL_RETENTION_MS,
  MANUAL_UNPARK_REASON,
  PARK_RECOVERY_WINDOW_MS,
  appendFunnelEvent,
  isFunnelStoreAvailable,
  parkRecoveryFigures,
  resetFunnelStoreForTests,
} from './funnel-store.js'

let dir: string
const proj = '/abs/funnel-project'
const other = '/abs/other-project'

/** A fixed "now" so every relative timestamp in a test reads as an offset from it. */
const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

const park = (at: number, intentId = 'A', workspacePath = proj) =>
  appendFunnelEvent({
    workspacePath,
    intentId,
    stage: 'parked',
    reasonCode: 'max_attempts_reached',
    at,
  })

const unpark = (at: number, intentId = 'A', workspacePath = proj) =>
  appendFunnelEvent({
    workspacePath,
    intentId,
    stage: 'unparked',
    reasonCode: MANUAL_UNPARK_REASON,
    at,
  })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-funnel-db-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetFunnelStoreForTests()
  resetQueueStoreForTests()
  // Materialize the lazily-created schema up front: a refused write returns before
  // it ever touches the db, so a rejection test would otherwise query no table.
  isFunnelStoreAvailable()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDbForTests()
  resetFunnelStoreForTests()
  resetQueueStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('funnel_event schema', () => {
  it('has exactly the six agreed columns and no free-text column', () => {
    expect(isFunnelStoreAvailable()).toBe(true)
    const cols = getDb()!.all<{ name: string }>('PRAGMA table_info(funnel_event)')
    expect(cols.map((c) => c.name).sort()).toEqual([
      'at',
      'id',
      'intent_id',
      'reason_code',
      'stage',
      'workspace_id',
    ])
  })
})

describe('write boundary', () => {
  it('accepts a queue reason code for parked and the fixed code for unparked', () => {
    expect(park(NOW)).toBe(true)
    expect(unpark(NOW + 1)).toBe(true)
  })

  it('refuses an unknown stage', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const written = appendFunnelEvent({
      workspacePath: proj,
      intentId: 'A',
      // Only `parked` / `unparked` are observable transitions.
      stage: 'resumed' as never,
      reasonCode: 'max_attempts_reached',
      at: NOW,
    })
    expect(written).toBe(false)
    expect(rowCount()).toBe(0)
  })

  it('refuses free text where a reason code belongs', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // This is exactly the shape of a `parkDetail` — a human-readable summary that
    // would leak the intent title and the failure message if it landed.
    const written = appendFunnelEvent({
      workspacePath: proj,
      intentId: 'A',
      stage: 'parked',
      reasonCode: '「重构登录」第 3 次失败: turn error',
      at: NOW,
    })
    expect(written).toBe(false)
    expect(rowCount()).toBe(0)
  })

  it('refuses a queue reason code on the unpark side', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      appendFunnelEvent({
        workspacePath: proj,
        intentId: 'A',
        stage: 'unparked',
        reasonCode: 'needs_human_decision',
        at: NOW,
      }),
    ).toBe(false)
    expect(rowCount()).toBe(0)
  })

  it('stores only ids, the enum values and the timestamp', () => {
    park(NOW)
    const row = getDb()!.get<Record<string, unknown>>('SELECT * FROM funnel_event')!
    expect(Object.keys(row).sort()).toEqual([
      'at',
      'id',
      'intent_id',
      'reason_code',
      'stage',
      'workspace_id',
    ])
    expect(row.stage).toBe('parked')
    expect(row.reason_code).toBe('max_attempts_reached')
    expect(row.intent_id).toBe('A')
  })
})

describe('park recovery figures', () => {
  it('reports no samples rather than 0% on an empty table', () => {
    expect(parkRecoveryFigures(proj, NOW)).toEqual({
      windowMs: PARK_RECOVERY_WINDOW_MS,
      eligible: 0,
      recovered: 0,
      pending: 0,
      rate: null,
    })
  })

  it('counts a park recovered inside the window and one left parked', () => {
    park(NOW - 48 * HOUR, 'A')
    unpark(NOW - 46 * HOUR, 'A')
    park(NOW - 48 * HOUR, 'B')

    const f = parkRecoveryFigures(proj, NOW)
    expect(f).toMatchObject({ eligible: 2, recovered: 1, pending: 0 })
    expect(f.rate).toBe(0.5)
  })

  it('treats each park of the same intent as its own sample', () => {
    park(NOW - 100 * HOUR, 'A')
    unpark(NOW - 99 * HOUR, 'A')
    park(NOW - 80 * HOUR, 'A')
    unpark(NOW - 40 * HOUR, 'A') // 40h later — outside the window
    park(NOW - 30 * HOUR, 'A')
    unpark(NOW - 29 * HOUR, 'A')

    expect(parkRecoveryFigures(proj, NOW)).toMatchObject({
      eligible: 3,
      recovered: 2,
      pending: 0,
    })
  })

  it('pairs a park with the FIRST unpark that follows it, not the latest', () => {
    park(NOW - 50 * HOUR, 'A')
    unpark(NOW - 49 * HOUR, 'A') // 1h — the pair
    unpark(NOW - 10 * HOUR, 'A') // 40h — would fall outside the window if picked

    expect(parkRecoveryFigures(proj, NOW)).toMatchObject({ eligible: 1, recovered: 1 })
  })

  it('counts the exact 24h boundary as recovered and one second past it as not', () => {
    park(NOW - 100 * HOUR, 'A')
    unpark(NOW - 100 * HOUR + PARK_RECOVERY_WINDOW_MS, 'A')
    park(NOW - 100 * HOUR, 'B')
    unpark(NOW - 100 * HOUR + PARK_RECOVERY_WINDOW_MS + 1000, 'B')

    expect(parkRecoveryFigures(proj, NOW)).toMatchObject({ eligible: 2, recovered: 1 })
  })

  it('holds a park that has not finished its window out of the denominator', () => {
    park(NOW - 23 * HOUR - 3599 * 1000, 'A') // 23:59:59 old
    park(NOW - PARK_RECOVERY_WINDOW_MS, 'B') // exactly 24h old

    const f = parkRecoveryFigures(proj, NOW)
    expect(f).toMatchObject({ eligible: 1, recovered: 0, pending: 1 })
    expect(f.rate).toBe(0)
  })

  it('never counts a negative duration from a backwards clock as a recovery', () => {
    park(NOW - 50 * HOUR, 'A')
    unpark(NOW - 51 * HOUR, 'A') // the clock went backwards between the two writes

    expect(parkRecoveryFigures(proj, NOW)).toMatchObject({ eligible: 1, recovered: 0 })
  })

  it('keeps workspaces apart', () => {
    park(NOW - 48 * HOUR, 'A', proj)
    park(NOW - 48 * HOUR, 'A', other)
    unpark(NOW - 47 * HOUR, 'A', other)

    expect(parkRecoveryFigures(proj, NOW)).toMatchObject({ eligible: 1, recovered: 0 })
    expect(parkRecoveryFigures(other, NOW)).toMatchObject({ eligible: 1, recovered: 1 })
  })

  it('does not let one intent unpark another intent cycle', () => {
    park(NOW - 48 * HOUR, 'A')
    unpark(NOW - 47 * HOUR, 'B')

    expect(parkRecoveryFigures(proj, NOW)).toMatchObject({ eligible: 1, recovered: 0 })
  })

  it('keeps a deleted intent history in the workspace figures', () => {
    park(NOW - 48 * HOUR, 'A')
    unpark(NOW - 47 * HOUR, 'A')
    // Deleting the intent drops its scheduling metadata and decisions; the funnel
    // is an observation of what happened, so it survives until it rolls off.
    deleteQueueIntentMeta('A')

    expect(parkRecoveryFigures(proj, NOW)).toMatchObject({ eligible: 1, recovered: 1 })
  })
})

describe('90-day retention', () => {
  it('keeps an event exactly at the horizon and drops one past it', () => {
    park(NOW - FUNNEL_RETENTION_MS, 'A')
    park(NOW - FUNNEL_RETENTION_MS - 1, 'B')
    expect(rowCount()).toBe(2)

    // Reading the figures is enough to sweep — a machine with no new transitions
    // still cannot serve expired rows.
    parkRecoveryFigures(proj, NOW)
    expect(rowCount()).toBe(1)
    expect(
      getDb()!.get<{ intent_id: string }>('SELECT intent_id FROM funnel_event')!.intent_id,
    ).toBe('A')
  })

  it('sweeps on the write path too', () => {
    park(NOW - FUNNEL_RETENTION_MS - 1, 'old')
    expect(rowCount()).toBe(1)

    park(NOW, 'new')
    expect(rowCount()).toBe(1)
    expect(
      getDb()!.get<{ intent_id: string }>('SELECT intent_id FROM funnel_event')!.intent_id,
    ).toBe('new')
  })
})

describe('degradation', () => {
  /**
   * Make the db genuinely unopenable. A merely missing directory is not enough —
   * `getDb()` creates it — so the path is rooted at a regular FILE, which no
   * platform will accept as a parent directory.
   */
  const breakDb = () => {
    resetDbForTests()
    resetFunnelStoreForTests()
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    process.env.C3_DB_PATH = join(blocker, 'c3.db')
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('fails the read when the database is unavailable instead of reading as no samples', () => {
    breakDb()
    // An unopenable database is not evidence of zero parks. Reporting it as an
    // empty sample would let the panel show "not enough samples" for a machine
    // that was never measured at all.
    expect(isFunnelStoreAvailable()).toBe(false)
    expect(() => parkRecoveryFigures(proj, NOW)).toThrow()
  })

  it('still degrades the write to a reported no-op', () => {
    breakDb()
    // The other side of the asymmetry: a park that really happened must not be
    // undone because its observation could not be stored.
    expect(() => expect(park(NOW)).toBe(false)).not.toThrow()
  })
})

function rowCount(): number {
  return getDb()!.get<{ n: number }>('SELECT COUNT(*) AS n FROM funnel_event')!.n
}
