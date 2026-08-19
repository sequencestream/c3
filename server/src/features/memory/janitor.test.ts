/**
 * The memory janitor, driven by an injected clock. Two rules and one prohibition
 * are pinned here: a duplicate title keeps the newest row and demotes the rest
 * with a deterministic tie break; an inactive row survives until its own recovery
 * window closes and is erased at the boundary; and an `active` row is never
 * removed for being old — an old `preference` is precisely what this capability
 * exists to keep.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  countMemoryRows,
  createMemory,
  deleteMemory,
  ensureMemorySchema,
  getMemory,
  listActiveMemories,
  resetMemoryStoreForTests,
  type MemoryStatus,
  type MemoryType,
} from './store.js'
import { MEMORY_RECOVERY_DAYS, runMemorySweepOnce } from './janitor.js'

const DAY_MS = 24 * 60 * 60 * 1000
const T0 = 1_800_000_000_000

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-memory-janitor-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetMemoryStoreForTests()
  ensureMemorySchema()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetMemoryStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

/**
 * Insert a row directly. Ordinary writes deduplicate, so the duplicates the
 * janitor repairs can only arrive the way it must tolerate: a table written by
 * something other than one uninterrupted sequence of store calls.
 */
function rawRow(over: {
  id: string
  workspaceName?: string
  title: string
  updatedAt: number
  status?: MemoryStatus
  type?: MemoryType
  supersededBy?: string | null
}): void {
  getDb()!.run(
    `INSERT INTO workspace_memories
       (id, workspace_name, subject, type, title, title_key, content, status,
        source_session_id, created_at, updated_at, superseded_by)
     VALUES (?,?,NULL,?,?,?,?,?,'sess-1',?,?,?)`,
    over.id,
    over.workspaceName ?? 'alpha',
    over.type ?? 'fact',
    over.title,
    over.title.trim().replace(/\s+/g, ' ').toLowerCase(),
    `${over.id} 的正文`,
    over.status ?? 'active',
    over.updatedAt,
    over.updatedAt,
    over.supersededBy ?? null,
  )
}

function statusOf(id: string): { status: string; superseded_by: string | null } | undefined {
  return getDb()!.get('SELECT status, superseded_by FROM workspace_memories WHERE id = ?', id)
}

describe('duplicate repair', () => {
  it('retains the newest row and points the others at it', () => {
    rawRow({ id: 'a', title: '部署目标', updatedAt: T0 })
    rawRow({ id: 'b', title: '  部署目标 ', updatedAt: T0 + 5_000 })
    rawRow({ id: 'c', title: '部署目标', updatedAt: T0 + 1_000 })

    expect(runMemorySweepOnce({ now: T0 + 10_000 }).superseded).toBe(2)
    expect(statusOf('b')).toMatchObject({ status: 'active', superseded_by: null })
    expect(statusOf('a')).toMatchObject({ status: 'superseded', superseded_by: 'b' })
    expect(statusOf('c')).toMatchObject({ status: 'superseded', superseded_by: 'b' })
    expect(listActiveMemories('alpha').map((m) => m.id)).toEqual(['b'])
  })

  it('breaks an exact timestamp tie deterministically and repeats stably', () => {
    rawRow({ id: 'id-1', title: '同一秒写入', updatedAt: T0 })
    rawRow({ id: 'id-3', title: '同一秒写入', updatedAt: T0 })
    rawRow({ id: 'id-2', title: '同一秒写入', updatedAt: T0 })

    expect(runMemorySweepOnce({ now: T0 + 1 }).superseded).toBe(2)
    const keeper = listActiveMemories('alpha').map((m) => m.id)
    expect(keeper).toEqual(['id-3'])
    // Idempotent: a second sweep changes nothing and reaches the same conclusion.
    expect(runMemorySweepOnce({ now: T0 + 2 })).toEqual({ superseded: 0, removed: 0 })
    expect(listActiveMemories('alpha').map((m) => m.id)).toEqual(['id-3'])
  })

  it('never merges across workspaces or across distinct titles', () => {
    rawRow({ id: 'a', workspaceName: 'alpha', title: '部署目标', updatedAt: T0 })
    rawRow({ id: 'b', workspaceName: 'beta', title: '部署目标', updatedAt: T0 + 1 })
    rawRow({ id: 'c', workspaceName: 'alpha', title: '部署目标(内网)', updatedAt: T0 + 2 })

    expect(runMemorySweepOnce({ now: T0 + 10 })).toEqual({ superseded: 0, removed: 0 })
    expect(listActiveMemories('alpha')).toHaveLength(2)
    expect(listActiveMemories('beta')).toHaveLength(1)
  })

  it('demotes a soft-deleted duplicate too, and starts its recovery window now', () => {
    rawRow({ id: 'a', title: '部署目标', updatedAt: T0, status: 'deleted' })
    rawRow({ id: 'b', title: '部署目标', updatedAt: T0 + 1, status: 'active' })

    const sweptAt = T0 + 99_000
    expect(runMemorySweepOnce({ now: sweptAt }).superseded).toBe(1)
    const row = getDb()!.get<{ updated_at: number }>(
      'SELECT updated_at FROM workspace_memories WHERE id = ?',
      'a',
    )
    expect(row?.updated_at).toBe(sweptAt)
  })
})

describe('delayed physical removal', () => {
  it('keeps an inactive row until the boundary, then erases it', () => {
    const m = createMemory(
      {
        workspaceName: 'alpha',
        sourceSessionId: 's',
        type: 'fact',
        title: '旧事实',
        content: '过时了',
      },
      T0,
    )
    deleteMemory('alpha', m.id, T0)

    const boundary = T0 + MEMORY_RECOVERY_DAYS * DAY_MS
    expect(runMemorySweepOnce({ now: boundary - 1 })).toEqual({ superseded: 0, removed: 0 })
    expect(countMemoryRows('alpha')).toBe(1)

    expect(runMemorySweepOnce({ now: boundary }).removed).toBe(1)
    expect(countMemoryRows('alpha')).toBe(0)
    expect(getMemory('alpha', m.id)).toBeNull()
  })

  it('erases an expired superseded row and clears the dangling pointer left behind', () => {
    rawRow({
      id: 'old',
      title: '部署目标',
      updatedAt: T0,
      status: 'superseded',
      supersededBy: 'gone',
    })
    rawRow({ id: 'gone', title: '另一条', updatedAt: T0, status: 'deleted' })
    rawRow({
      id: 'live',
      title: '第三条',
      updatedAt: T0,
      status: 'superseded',
      supersededBy: 'gone',
    })

    const boundary = T0 + MEMORY_RECOVERY_DAYS * DAY_MS
    // `live` and `old` are also expired here, so raise them above the boundary first.
    getDb()!.run("UPDATE workspace_memories SET updated_at = ? WHERE id = 'live'", boundary)
    getDb()!.run("UPDATE workspace_memories SET updated_at = ? WHERE id = 'old'", boundary)

    expect(runMemorySweepOnce({ now: boundary }).removed).toBe(1)
    expect(statusOf('gone')).toBeUndefined()
    expect(statusOf('live')).toMatchObject({ superseded_by: null })
    expect(statusOf('old')).toMatchObject({ superseded_by: null })
  })

  it('never removes an active preference for being old', () => {
    const ancient = T0 - 5 * 365 * DAY_MS
    createMemory(
      {
        workspaceName: 'alpha',
        sourceSessionId: 's',
        type: 'preference',
        title: '一直以来的偏好',
        content: '用户五年前说过,至今有效。',
      },
      ancient,
    )
    rawRow({ id: 'old-fact', title: '一条老事实', updatedAt: ancient, type: 'fact' })

    expect(runMemorySweepOnce({ now: T0 })).toEqual({ superseded: 0, removed: 0 })
    expect(listActiveMemories('alpha')).toHaveLength(2)
  })
})

describe('resilience', () => {
  it('is a no-op on an empty table and on an unavailable database', () => {
    expect(runMemorySweepOnce({ now: T0 })).toEqual({ superseded: 0, removed: 0 })
    resetDbForTests()
    resetMemoryStoreForTests()
    process.env.C3_DB_PATH = join(home, 'c3.db', 'nested', 'c3.db')
    resetDbForTests()
    expect(runMemorySweepOnce({ now: T0 })).toEqual({ superseded: 0, removed: 0 })
  })
})
