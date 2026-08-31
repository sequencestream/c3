/**
 * Shared whole-table rebuild primitive for every c3 persistence domain.
 *
 * SQLite cannot ALTER a CHECK constraint or drop/reorder columns, so schema
 * evolution that touches the table shape rebuilds the table: rename the old rows
 * aside, create the new shape, copy (or prune) the data, then rebuild indexes on
 * the *new* table. The pitfall that has bitten this codebase twice: `RENAME`
 * carries the old indexes onto the archive table, so a later
 * `CREATE INDEX IF NOT EXISTS` on the old names silently skips and the fresh
 * table stays unindexed. This helper makes "indexes land on the new table" a
 * single responsibility instead of a per-callsite discipline.
 *
 * Invariants guaranteed here:
 *
 *  - **Archive rename comes first**, so the active table name is free and
 *    {@link RebuildOptions.newDdl newDdl} can be `CREATE TABLE` without
 *    `IF NOT EXISTS` (an `IF NOT EXISTS` would silently accept a same-named
 *    leftover and break the invariant).
 *  - **Indexes are created only on the new table**, after copy/cleanup.
 *  - **The active table is never `DROP`ped**; when the archive name is taken by
 *    an interrupted prior attempt, the current table is renamed aside with a
 *    timestamp suffix instead.
 *  - **Re-entry converges**: an interrupted run leaves `archive` (with the old
 *    data) plus maybe a half-built new table; a later run treats `archive` as
 *    the source and rebuilds from it.
 *
 * The helper never opens a transaction — callers keep their own boundaries
 * (SQLite has no nested BEGIN; the multi-table migrations wrap several rebuilds
 * in one tx). Shape gating stays a caller concern via {@link RebuildOptions.needs}.
 *
 * **Not for in-place table renames** (`ALTER TABLE old RENAME TO new` where the
 * target name differs and the shape is unchanged): indexes correctly stay on the
 * renamed table and {@link rebuildTable} would needlessly copy rows. Those paths
 * stay as guarded `RENAME TO` at each callsite (see automations / intents /
 * session-metadata rename migrations).
 */
import { tableExists, type Db } from './db.js'

/**
 * Column-projection copy. `columns` is the INSERT target list; `select` is the
 * SELECT projection with the same length — a slot may be a literal (e.g. `NULL`
 * to drop a column's value). Omitted `select` copies columns verbatim.
 */
export interface CopyProjection {
  columns: string[]
  select?: string[]
}

export type CopySpec = CopyProjection | ((d: Db, source: string) => CopyProjection | null) | null

export interface RebuildOptions {
  /** Active table name (the one reads/writes touch). */
  table: string
  /** Preferred archive name; a taken name is suffixed with a timestamp. */
  archive: string
  /** Full `CREATE TABLE …` without `IF NOT EXISTS` (name is free after rename). */
  newDdl: string
  /**
   * Copy projection, or `null` to prune (copy nothing — e.g. old shared rows are
   * deliberately cut). A function resolves lazily against the archive table, for
   * copies that depend on which columns the source actually has.
   */
  copy: CopySpec
  /** Index DDL to run on the NEW table (and whose names are freed on a kept archive). */
  indexDdl: string
  /** `true` = keep the archive after copying (safe-cut); `false` = DROP it. */
  keepArchive: boolean
  /** Shape gate: `true` when the active table still needs this rebuild. */
  needs: (d: Db) => boolean
}

const INDEX_NAME_RE =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g

function indexNames(indexDdl: string): string[] {
  const names: string[] = []
  for (const m of indexDdl.matchAll(INDEX_NAME_RE)) names.push(m[1])
  return names
}

/**
 * Rebuild {@link RebuildOptions.table} to {@link RebuildOptions.newDdl newDdl}'s
 * shape, preserving/pruning rows per `copy`, with indexes created on the new
 * table. No-op when the active table already has the target shape and no archive
 * is left over. Idempotent: re-running a converged table does nothing.
 */
export function rebuildTable(d: Db, opts: RebuildOptions): void {
  const { table, archive, newDdl, copy, indexDdl, keepArchive, needs } = opts
  const archivePresent = tableExists(d, archive)
  const activeIsOld = tableExists(d, table) && needs(d)

  // ---- Find the data source and free the active name ----
  let source: string | null = null
  if (activeIsOld) {
    // The active table still carries the old shape: rename it aside. When the
    // archive name is taken (interrupted prior attempt), park it with a
    // timestamp suffix rather than dropping anything.
    source = archivePresent ? `${archive}_${Date.now()}` : archive
    d.exec(`ALTER TABLE ${table} RENAME TO ${source}`)
  } else if (archivePresent && !keepArchive) {
    // A drop-run interrupted after the rename left the archive plus a half-built
    // new table. The archive is the reliable source; park the half-built table
    // aside, never DROP it. (A KEPT archive next to a converged active table is
    // the normal safe-cut end state and is a no-op.)
    source = archive
    if (tableExists(d, table)) {
      d.exec(`ALTER TABLE ${table} RENAME TO ${archive}_${Date.now()}`)
    }
  }

  // ---- Converged: active table is the target shape, nothing to rebuild ----
  if (source === null) {
    if (!tableExists(d, table)) d.exec(newDdl)
    if (indexDdl.trim()) d.exec(indexDdl)
    return
  }

  // ---- Create the new table (name is free now) ----
  d.exec(newDdl)

  // ---- Copy (or prune) ----
  const projection = typeof copy === 'function' ? copy(d, source) : copy
  if (projection && tableExists(d, source)) {
    const into = projection.columns.join(', ')
    const sel = (projection.select ?? projection.columns).join(', ')
    d.exec(`INSERT INTO ${table} (${into}) SELECT ${sel} FROM ${source}`)
  }

  // ---- Archive policy ----
  if (!keepArchive) {
    // DROP the archive — its indexes go with it, freeing the names.
    d.exec(`DROP TABLE IF EXISTS ${source}`)
  }
  // Free every index name `indexDdl` will create, wherever a RENAME carried it:
  // on a kept archive (keep) or on a half-built table parked aside after an
  // interrupted run (drop). Otherwise `CREATE INDEX IF NOT EXISTS` sees the name
  // still taken and silently skips, leaving the new table unindexed.
  for (const name of indexNames(indexDdl)) {
    d.exec(`DROP INDEX IF EXISTS ${name}`)
  }

  // ---- Indexes land on the new table ----
  if (indexDdl.trim()) d.exec(indexDdl)
}
