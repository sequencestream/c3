/**
 * `intent_logs` store layer — schema idempotency, insert/list ordering, per-intent
 * isolation, the actor `'system'` fallback, and the db-unavailable degradation
 * contract (`listIntentLogs` → `[]`, `insertIntentLog` → throw, same as `requireDb`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { insertIntentLog, listIntentLogs, resetStoreForTests } from './store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-intent-logs-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** Make Date.now strictly increasing so created_at ordering is deterministic. */
function tickClock(start = 1_000_000): void {
  let now = start
  vi.spyOn(Date, 'now').mockImplementation(() => ++now)
}

describe('intent_logs schema', () => {
  it('re-ensures idempotently on the same db file (no duplicate-table error)', () => {
    insertIntentLog('int-1', 'intent_created', '创建意图: A', 'alice')
    // Re-open the same file: SCHEMA runs again over the existing tables.
    resetDbForTests()
    resetStoreForTests()
    expect(() => insertIntentLog('int-1', 'intent_updated', '更新意图: A', 'alice')).not.toThrow()
    expect(listIntentLogs('int-1')).toHaveLength(2)
  })
})

describe('insertIntentLog / listIntentLogs', () => {
  it('returns entries newest-first (created_at DESC)', () => {
    tickClock()
    insertIntentLog('int-1', 'intent_created', '创建意图: A', 'alice')
    insertIntentLog('int-1', 'status_changed', '状态变更: todo → in_progress', 'automation')
    insertIntentLog('int-1', 'status_changed', '状态变更: in_progress → done', 'automation')
    const logs = listIntentLogs('int-1')
    expect(logs.map((l) => l.summary)).toEqual([
      '状态变更: in_progress → done',
      '状态变更: todo → in_progress',
      '创建意图: A',
    ])
    expect(logs.every((l) => l.intentId === 'int-1')).toBe(true)
  })

  it('keeps different intents isolated', () => {
    insertIntentLog('int-1', 'intent_created', '创建意图: A', 'alice')
    insertIntentLog('int-2', 'intent_created', '创建意图: B', 'bob')
    expect(listIntentLogs('int-1')).toHaveLength(1)
    expect(listIntentLogs('int-2')).toHaveLength(1)
    expect(listIntentLogs('int-1')[0].actor).toBe('alice')
    expect(listIntentLogs('int-2')[0].actor).toBe('bob')
  })

  it("falls back to 'system' when actor is omitted or null; keeps explicit actors", () => {
    insertIntentLog('int-1', 'intent_created', '创建意图: A')
    insertIntentLog('int-1', 'intent_updated', '更新意图: A', null)
    insertIntentLog('int-1', 'spec_approved', '批准 spec', 'carol')
    const actors = listIntentLogs('int-1').map((l) => l.actor)
    expect(actors).toContain('carol')
    expect(actors.filter((a) => a === 'system')).toHaveLength(2)
  })

  it('carries the full projection shape (id/operationType/createdAt)', () => {
    insertIntentLog('int-1', 'pr_created', '创建 PR #7', 'dave')
    const [log] = listIntentLogs('int-1')
    expect(log.id).toBeTruthy()
    expect(log.operationType).toBe('pr_created')
    expect(log.summary).toBe('创建 PR #7')
    expect(typeof log.createdAt).toBe('number')
  })
})

describe('db-unavailable degradation', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    resetDbForTests()
    resetStoreForTests()
  })

  it('listIntentLogs returns [] and insertIntentLog throws', () => {
    expect(listIntentLogs('int-1')).toEqual([])
    expect(() => insertIntentLog('int-1', 'intent_created', '创建意图: A')).toThrow()
  })
})
