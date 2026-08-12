/**
 * The `workspaces` table — the mapping between a workspace's opaque wire id and its
 * absolute path on disk, previously the `workspaces` array inside
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`.
 *
 * The id is the identity `workspace_configs` rows hang off, which is why a workspace
 * removed from the sidebar is marked `registered=0` instead of being deleted: dropping
 * the row would orphan its configuration, and re-adding the same directory would mint
 * a new id and silently start from defaults. Unregistering keeps the settings for the
 * day the directory comes back, and keeps configuration imported for a path that was
 * never a registered workspace (legacy `projectConfigs` collected plenty) out of the
 * workspace list.
 *
 * Reads degrade to empty when the db is unavailable — c3 boots with no workspaces
 * rather than not at all.
 */
import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { configDb, configTx, requireConfigDb } from './config-store.js'

/** One workspace registration. `registered=false` ⇒ configuration-only, not listed. */
export interface WorkspaceRow {
  id: string
  path: string
  name: string
  lastAccessed: number
  registered: boolean
}

interface RawWorkspaceRow {
  id: string
  path: string
  name: string
  last_accessed: number
  registered: number
}

function toRow(raw: RawWorkspaceRow): WorkspaceRow {
  return {
    id: raw.id,
    path: raw.path,
    name: raw.name,
    lastAccessed: raw.last_accessed,
    registered: raw.registered !== 0,
  }
}

const SELECT = 'SELECT id, path, name, last_accessed, registered FROM workspaces'

/** Registered workspaces only, unordered (callers sort by recency). */
export function listWorkspaceRows(): WorkspaceRow[] {
  const d = configDb()
  if (!d) return []
  return d.all<RawWorkspaceRow>(`${SELECT} WHERE registered=1`).map(toRow)
}

/** Every row, including configuration-only ones — for migrations and diagnostics. */
export function listAllWorkspaceRows(): WorkspaceRow[] {
  const d = configDb()
  if (!d) return []
  return d.all<RawWorkspaceRow>(SELECT).map(toRow)
}

export function findWorkspaceById(id: string): WorkspaceRow | null {
  const d = configDb()
  if (!d) return null
  const raw = d.get<RawWorkspaceRow>(`${SELECT} WHERE id=?`, id)
  return raw ? toRow(raw) : null
}

export function findWorkspaceByPath(path: string): WorkspaceRow | null {
  const d = configDb()
  if (!d) return null
  const raw = d.get<RawWorkspaceRow>(`${SELECT} WHERE path=?`, resolve(path))
  return raw ? toRow(raw) : null
}

/**
 * Insert or update a row verbatim. Used by the legacy import, which must preserve the
 * ids already handed out on the wire — a fresh uuid would invalidate every workspace
 * id the running web console holds.
 */
export function putWorkspaceRow(row: WorkspaceRow, now: number): void {
  const d = requireConfigDb()
  d.run(
    `INSERT INTO workspaces (id, path, name, last_accessed, registered, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       path=excluded.path,
       name=excluded.name,
       last_accessed=excluded.last_accessed,
       registered=excluded.registered,
       updated_at=excluded.updated_at`,
    row.id,
    resolve(row.path),
    row.name,
    row.lastAccessed,
    row.registered ? 1 : 0,
    now,
    now,
  )
}

/**
 * Register `path` as a workspace, reusing the existing id when the directory was
 * registered (or configured) before. Returns the row.
 */
export function registerWorkspace(path: string, now: number): WorkspaceRow {
  const abs = resolve(path)
  return configTx((d) => {
    const existing = findWorkspaceByPath(abs)
    if (existing) {
      d.run(
        'UPDATE workspaces SET registered=1, last_accessed=?, updated_at=? WHERE id=?',
        now,
        now,
        existing.id,
      )
      return { ...existing, registered: true, lastAccessed: now }
    }
    const row: WorkspaceRow = {
      id: randomUUID(),
      path: abs,
      name: basename(abs) || abs,
      lastAccessed: now,
      registered: true,
    }
    putWorkspaceRow(row, now)
    return row
  })
}

/**
 * The id for `path`, creating a configuration-only row when the directory is not a
 * registered workspace. Lets configuration exist for a path the user never added (or
 * has since removed) without that path showing up as a workspace.
 */
export function ensureWorkspaceId(path: string, now: number): string {
  const abs = resolve(path)
  const existing = findWorkspaceByPath(abs)
  if (existing) return existing.id
  const row: WorkspaceRow = {
    id: randomUUID(),
    path: abs,
    name: basename(abs) || abs,
    lastAccessed: 0,
    registered: false,
  }
  putWorkspaceRow(row, now)
  return row.id
}

/** Remove a workspace from the list while keeping its id and configuration. */
export function unregisterWorkspace(path: string): void {
  const d = configDb()
  if (!d) return
  d.run('UPDATE workspaces SET registered=0, updated_at=? WHERE path=?', Date.now(), resolve(path))
}

/** Bump the recent-access timestamp (re-sorts the sidebar). No-op for unknown paths. */
export function touchWorkspaceRow(path: string, now: number): void {
  const d = configDb()
  if (!d) return
  d.run(
    'UPDATE workspaces SET last_accessed=?, updated_at=? WHERE path=? AND registered=1',
    now,
    now,
    resolve(path),
  )
}
