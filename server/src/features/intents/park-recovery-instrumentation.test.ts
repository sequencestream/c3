/**
 * Where park observation attaches to the queue's park state.
 *
 * The contract is one-directional and it runs both ways: a transition that did
 * not durably happen must not be observed, and an observation that fails to land
 * must not change the transition. Everything else here is about not
 * double-counting — a repeat park is not a new park cycle, and a repeat unpark is
 * not a new recovery, so neither may produce a row.
 *
 * The queue store is mocked so a failed state write can be staged; the funnel
 * store is REAL, over a temp-file database, because the whole point is what
 * actually lands in the table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- Mocks (must precede the imports under test) ----

const hoisted = vi.hoisted(() => ({
  metas: new Map<string, Record<string, unknown>>(),
  putSucceeds: true,
}))

vi.mock('./queue-store.js', () => {
  const empty = (intentId: string): Record<string, unknown> => ({
    intentId,
    failureCount: 0,
    backoffCount: 0,
    backoffUntil: null,
    parked: false,
    parkReason: null,
    parkDetail: null,
    cooldownUntil: null,
    updatedAt: 0,
  })
  return {
    getQueueIntentMetaById: (id: string) => hoisted.metas.get(id) ?? empty(id),
    putQueueIntentMeta: (_w: string, m: Record<string, unknown>) => {
      // A refused write leaves the durable state untouched — exactly the case the
      // observation must not record.
      if (!hoisted.putSucceeds) return false
      hoisted.metas.set(m.intentId as string, { ...m })
      return true
    },
    appendQueueDecisions: () => true,
  }
})

vi.mock('./store.js', () => ({ getIntent: vi.fn(() => null) }))
vi.mock('./lifecycle-events.js', () => ({ publishIntentLifecycle: vi.fn() }))
vi.mock('./pr-status-sync.js', () => ({ syncUnconfirmedDependencyPrsInBackground: vi.fn() }))

// ---- Imports under test ----

import { resetDbForTests, getDb } from '../../kernel/infra/db.js'
import {
  isFunnelStoreAvailable,
  resetFunnelStoreForTests,
  MANUAL_UNPARK_REASON,
} from './funnel-store.js'
import { applyHumanOverride, applyPark, clearPark, recordFailure } from './queue-outcome-actions.js'
import { QUEUE_MAX_ATTEMPTS } from '../../kernel/queue/index.js'
import type { QueueActionContext } from './queue-action-context.js'

let dir: string
const proj = '/abs/park-observation'

const ctx = {
  workspacePath: proj,
  hooks: { broadcastQueueDetail: vi.fn(), createUserTodo: vi.fn() },
  tickId: () => 'tick-1',
} as unknown as QueueActionContext

interface EventRow {
  workspace_id: string
  intent_id: string
  stage: string
  reason_code: string
  at: number
}

function events(): EventRow[] {
  return getDb()!.all<EventRow>('SELECT * FROM funnel_event ORDER BY rowid ASC')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-park-obs-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetFunnelStoreForTests()
  isFunnelStoreAvailable()
  hoisted.metas.clear()
  hoisted.putSucceeds = true
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDbForTests()
  resetFunnelStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('recordFailure — the failure ladder', () => {
  it('observes nothing while an intent is merely backing off', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < QUEUE_MAX_ATTEMPTS - 1; i++) {
      recordFailure(ctx, 'A', 'turn_error', 'boom')
    }
    expect(events()).toEqual([])
  })

  it('observes exactly one park when the ladder reaches the cap', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < QUEUE_MAX_ATTEMPTS; i++) {
      recordFailure(ctx, 'A', 'turn_error', 'boom')
    }
    // A further failure on an already-parked intent is not a second park cycle.
    recordFailure(ctx, 'A', 'turn_error', 'boom again')

    expect(events()).toHaveLength(1)
    expect(events()[0]).toMatchObject({ stage: 'parked', reason_code: 'turn_error' })
  })
})

describe('applyPark', () => {
  it('records one parked event carrying the reason code, never the detail', () => {
    applyPark(ctx, 'A', 'max_attempts_reached', '「重构登录」连续失败 3 次: turn error')

    expect(events()).toHaveLength(1)
    const row = events()[0]
    expect(row.stage).toBe('parked')
    expect(row.reason_code).toBe('max_attempts_reached')
    expect(row.intent_id).toBe('A')
    // The detail string is where a title and a failure message live; it stops here.
    expect(JSON.stringify(row)).not.toContain('重构登录')
  })

  it('does not record a second event when an already-parked intent is parked again', () => {
    applyPark(ctx, 'A', 'max_attempts_reached', 'first')
    applyPark(ctx, 'A', 'judge_stuck', 'second')

    expect(events()).toHaveLength(1)
  })

  it('records nothing when the state write itself was refused', () => {
    hoisted.putSucceeds = false
    applyPark(ctx, 'A', 'max_attempts_reached', 'detail')

    expect(events()).toEqual([])
  })
})

describe('clearPark', () => {
  it('records one unparked event with the fixed manual reason code', () => {
    applyPark(ctx, 'A', 'max_attempts_reached', 'detail')
    expect(clearPark(proj, 'A')).toBe(true)

    const rows = events()
    expect(rows.map((r) => r.stage)).toEqual(['parked', 'unparked'])
    expect(rows[1].reason_code).toBe(MANUAL_UNPARK_REASON)
  })

  it('records nothing when there was no park to clear', () => {
    expect(clearPark(proj, 'A')).toBe(false)
    expect(events()).toEqual([])
  })

  it('records nothing when the state write was refused', () => {
    applyPark(ctx, 'A', 'max_attempts_reached', 'detail')
    hoisted.putSucceeds = false

    expect(clearPark(proj, 'A')).toBe(true)
    expect(events().map((r) => r.stage)).toEqual(['parked'])
  })

  it('still reports the unpark when the observation write fails', () => {
    applyPark(ctx, 'A', 'max_attempts_reached', 'detail')
    // Drop the observation table out from under the store: the park state has
    // already been written, so the unpark must still succeed.
    getDb()!.exec('DROP TABLE funnel_event')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(clearPark(proj, 'A')).toBe(true)
    expect(hoisted.metas.get('A')).toMatchObject({ parked: false })
  })
})

describe('applyHumanOverride', () => {
  it('records a parked event when a human ruling blocks an unparked intent', () => {
    expect(applyHumanOverride(proj, 'A', 'block', 'alice', 'tick-1')).toBe(true)

    expect(events()).toHaveLength(1)
    expect(events()[0]).toMatchObject({ stage: 'parked', reason_code: 'needs_human_decision' })
  })

  it('records an unparked event when a human ruling continues a parked intent', () => {
    applyPark(ctx, 'A', 'max_attempts_reached', 'detail')
    expect(applyHumanOverride(proj, 'A', 'continue', 'alice', 'tick-1')).toBe(true)

    expect(events().map((r) => r.stage)).toEqual(['parked', 'unparked'])
    expect(events()[1].reason_code).toBe(MANUAL_UNPARK_REASON)
  })

  it('records nothing when the ruling does not move the park flag', () => {
    applyPark(ctx, 'A', 'max_attempts_reached', 'detail')
    // Blocking an intent that is already parked restates the ruling; it is not a
    // new park cycle and must not add a sample.
    expect(applyHumanOverride(proj, 'A', 'block', 'alice', 'tick-1')).toBe(true)

    expect(events()).toHaveLength(1)
  })

  it('never leaves an unpark with no matching park behind it', () => {
    // The pairing rule reads insertion order, so a block that produced no `parked`
    // would make the following unpark orphan — and skew every later pair.
    applyHumanOverride(proj, 'A', 'block', 'alice', 'tick-1')
    clearPark(proj, 'A')

    expect(events().map((r) => r.stage)).toEqual(['parked', 'unparked'])
  })
})
