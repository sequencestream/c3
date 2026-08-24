/**
 * Whole-table rebuild helper: index ownership (indexes must land on the NEW
 * table, never ride a RENAME onto an archive), idempotent re-run, and re-entry
 * convergence from an interrupted state (archive + half-built new table).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import { tableColumns } from './robot-db.js'
import { rebuildTable, type RebuildOptions } from './table-rebuild.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-table-rebuild-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(home, { recursive: true, force: true })
})

const NEW_T_DDL = `CREATE TABLE t (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, label TEXT, extra TEXT);`
const IDX = `CREATE INDEX IF NOT EXISTS idx_t_seq ON t(seq);`

function d(): Db {
  return getDb()!
}

function rebuild(over: Partial<RebuildOptions> = {}): void {
  rebuildTable(d(), {
    table: 't',
    archive: 't_pre',
    newDdl: NEW_T_DDL,
    copy: null,
    indexDdl: IDX,
    keepArchive: false,
    needs: () => true,
    ...over,
  })
}

function indexOwner(name: string): string | undefined {
  return d().get<{ tbl_name: string }>(
    `SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?`,
    name,
  )?.tbl_name
}

function tableNames(): string[] {
  return d()
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((r) => r.name)
}

describe('indexes land on the new table', () => {
  it('keeps a pruned archive but moves the index onto the fresh table', () => {
    d().exec('CREATE TABLE t (id TEXT PRIMARY KEY, seq INTEGER)')
    d().exec("INSERT INTO t VALUES ('a',1),('b',2)")
    d().exec('CREATE INDEX idx_t_seq ON t(seq)')

    rebuild({ keepArchive: true, copy: null })

    // Archive retained (safe-cut), active table is the new empty shape.
    expect(tableNames()).toContain('t_pre')
    expect(d().all('SELECT id FROM t')).toEqual([])
    expect(d().all('SELECT id FROM t_pre').length).toBe(2)
    // The index name must attach to the NEW table, not stay on the archive.
    expect(indexOwner('idx_t_seq')).toBe('t')
    expect(
      d().all<{ tbl_name: string }>(
        "SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_t_seq'",
      ),
    ).toEqual([{ tbl_name: 't' }])
  })

  it('drops the archive after copying and indexes the new table', () => {
    d().exec('CREATE TABLE t (id TEXT PRIMARY KEY, seq INTEGER, label TEXT)')
    d().exec("INSERT INTO t VALUES ('a',1,'x'),('b',2,'y')")
    d().exec('CREATE INDEX idx_t_seq ON t(seq)')

    rebuild({
      keepArchive: false,
      copy: { columns: ['id', 'seq', 'label'], select: ['id', 'seq', 'label'] },
    })

    expect(tableNames()).not.toContain('t_pre')
    expect(indexOwner('idx_t_seq')).toBe('t')
    expect(d().all('SELECT id, seq, label FROM t ORDER BY id')).toEqual([
      { id: 'a', seq: 1, label: 'x' },
      { id: 'b', seq: 2, label: 'y' },
    ])
  })

  it('prunes a column through a NULL projection', () => {
    d().exec('CREATE TABLE t (id TEXT PRIMARY KEY, seq INTEGER, secret TEXT)')
    d().exec("INSERT INTO t VALUES ('a',1,'s1')")

    rebuild({ copy: { columns: ['id', 'seq'], select: ['id', 'seq'] } })

    expect(d().all('SELECT id, seq, extra FROM t')).toEqual([{ id: 'a', seq: 1, extra: null }])
  })
})

describe('idempotent re-run is a no-op', () => {
  it('re-running on a converged table neither renames aside nor changes data', () => {
    d().exec('CREATE TABLE t (id TEXT PRIMARY KEY, seq INTEGER)')
    d().exec("INSERT INTO t VALUES ('a',1)")
    const needs = (dd: Db): boolean => !tableColumns(dd, 't').has('extra')

    rebuild({ needs, keepArchive: true })
    expect(tableNames()).toContain('t_pre')
    expect(indexOwner('idx_t_seq')).toBe('t')

    const before = JSON.stringify(tableNames())
    rebuild({ needs, keepArchive: true })

    // No new archive, no data change, index ownership stable.
    expect(JSON.stringify(tableNames())).toBe(before)
    // Pruned copy: the row lives in the kept archive, the active table stays empty.
    expect(d().all('SELECT id, seq FROM t')).toEqual([])
    expect(d().all('SELECT id FROM t_pre')).toEqual([{ id: 'a' }])
    expect(indexOwner('idx_t_seq')).toBe('t')
  })
})

describe('re-entry converges from an interrupted state', () => {
  it('recovers data from the archive when a half-built new table exists', () => {
    // Interrupted prior run: archive holds the data, a half-built new-shape
    // table (with the old index name attached) was left behind, no copy ran.
    d().exec('CREATE TABLE t_pre (id TEXT PRIMARY KEY, seq INTEGER, label TEXT)')
    d().exec("INSERT INTO t_pre VALUES ('a',1,'x'),('b',2,'y')")
    d().exec('CREATE TABLE t (id TEXT PRIMARY KEY, seq INTEGER, label TEXT, extra TEXT)')
    d().exec('CREATE INDEX idx_t_seq ON t(seq)')
    // Shape gate looks at the ACTIVE table, which is already new — only the
    // leftover archive reveals the interrupted migration.
    const needs = (dd: Db): boolean => !tableColumns(dd, 't').has('extra')

    rebuild({
      needs,
      keepArchive: false,
      copy: { columns: ['id', 'seq', 'label'], select: ['id', 'seq', 'label'] },
    })

    // Data recovered, archive gone, half-built table parked aside, index on t.
    expect(d().all('SELECT id, seq, label FROM t ORDER BY id')).toEqual([
      { id: 'a', seq: 1, label: 'x' },
      { id: 'b', seq: 2, label: 'y' },
    ])
    expect(tableNames()).not.toContain('t_pre')
    expect(tableNames().some((n) => n.startsWith('t_pre_'))).toBe(true)
    expect(indexOwner('idx_t_seq')).toBe('t')
  })

  it('parks the old active table aside when the archive name is taken', () => {
    // Archive name already occupied by an older leftover; the current active
    // table is still old-shaped and must be renamed aside — never DROPPED.
    d().exec('CREATE TABLE t_pre (id TEXT PRIMARY KEY, seq INTEGER)')
    d().exec("INSERT INTO t_pre VALUES ('old',9)")
    d().exec('CREATE TABLE t (id TEXT PRIMARY KEY, seq INTEGER)')
    d().exec("INSERT INTO t VALUES ('a',1)")
    d().exec('CREATE INDEX idx_t_seq ON t(seq)')

    rebuild({ keepArchive: true, copy: null })

    const parked = tableNames().filter((n) => n.startsWith('t_pre_'))
    expect(parked).toHaveLength(1)
    expect(d().all(`SELECT id FROM ${parked[0]}`)).toEqual([{ id: 'a' }])
    expect(d().all('SELECT id FROM t_pre')).toEqual([{ id: 'old' }])
    expect(d().all('SELECT id FROM t')).toEqual([])
    expect(indexOwner('idx_t_seq')).toBe('t')
  })
})
