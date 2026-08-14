/**
 * The `workspaces` table — the mapping between a workspace's immutable name and its
 * absolute path on disk, previously the `workspaces` array inside
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json`.
 *
 * The name is the identity `workspace_configs` rows hang off, which is why a workspace
 * removed from the sidebar is marked `registered=0` instead of being deleted: dropping
 * the row would orphan its configuration, and re-adding the same directory would mint
 * a new name and silently start from defaults. Unregistering keeps the settings for the
 * day the directory comes back, and keeps configuration imported for a path that was
 * never a registered workspace (legacy `projectConfigs` collected plenty) out of the
 * workspace list.
 *
 * Reads degrade to empty when the db is unavailable — c3 boots with no workspaces
 * rather than not at all.
 */
import { basename, resolve } from 'node:path'
import { configDb, configTx, requireConfigDb } from './config-store.js'

/** One workspace registration. `registered=false` ⇒ configuration-only, not listed. */
export interface WorkspaceRow {
  name: string
  path: string
  lastAccessed: number
  registered: boolean
}

interface RawWorkspaceRow {
  name: string
  path: string
  last_accessed: number
  registered: number
}

function toRow(raw: RawWorkspaceRow): WorkspaceRow {
  return {
    name: raw.name,
    path: raw.path,
    lastAccessed: raw.last_accessed,
    registered: raw.registered !== 0,
  }
}

const SELECT = 'SELECT name, path, last_accessed, registered FROM workspaces'

export function normalizeWorkspaceName(value: string): string | null {
  const name = value.trim()
  return name.length > 0 && Array.from(name).length <= 64 ? name : null
}

function availableName(path: string): string {
  const base = normalizeWorkspaceName(basename(path)) ?? 'workspace'
  if (!findWorkspaceByName(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const prefix = Array.from(base)
      .slice(0, 64 - suffix.length)
      .join('')
    const candidate = `${prefix}${suffix}`
    if (!findWorkspaceByName(candidate)) return candidate
  }
}

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

export function findWorkspaceByName(name: string): WorkspaceRow | null {
  const d = configDb()
  if (!d) return null
  const raw = d.get<RawWorkspaceRow>(`${SELECT} WHERE name=?`, name)
  return raw ? toRow(raw) : null
}

export function findWorkspaceByPath(path: string): WorkspaceRow | null {
  const d = configDb()
  if (!d) return null
  const raw = d.get<RawWorkspaceRow>(`${SELECT} WHERE path=?`, resolve(path))
  return raw ? toRow(raw) : null
}

/**
 * Insert or update one immutable workspace identity.
 */
export function putWorkspaceRow(row: WorkspaceRow, now: number): void {
  const d = requireConfigDb()
  d.run(
    `INSERT INTO workspaces (name, path, last_accessed, registered, created_at, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET
       last_accessed=excluded.last_accessed,
       registered=excluded.registered,
       updated_at=excluded.updated_at`,
    row.name,
    resolve(row.path),
    row.lastAccessed,
    row.registered ? 1 : 0,
    now,
    now,
  )
}

/**
 * Register `path` as a workspace, reusing the existing name when the directory was
 * registered (or configured) before. Returns the row.
 */
export function registerWorkspace(
  path: string,
  nameOrNow: string | number,
  maybeNow?: number,
): WorkspaceRow {
  const abs = resolve(path)
  const now = typeof nameOrNow === 'number' ? nameOrNow : maybeNow!
  const requestedName = typeof nameOrNow === 'string' ? nameOrNow : basename(abs) || 'workspace'
  return configTx((d) => {
    const existing = findWorkspaceByPath(abs)
    if (existing) {
      d.run(
        'UPDATE workspaces SET registered=1, last_accessed=?, updated_at=? WHERE name=?',
        now,
        now,
        existing.name,
      )
      return { ...existing, registered: true, lastAccessed: now }
    }
    const normalized = normalizeWorkspaceName(requestedName)
    if (!normalized) throw new Error('workspace.nameInvalid')
    if (findWorkspaceByName(normalized)) throw new Error('workspace.nameConflict')
    const row: WorkspaceRow = {
      path: abs,
      name: normalized,
      lastAccessed: now,
      registered: true,
    }
    putWorkspaceRow(row, now)
    return row
  })
}

/**
 * The name for `path`, creating a configuration-only row when the directory is not a
 * registered workspace. Lets configuration exist for a path the user never added (or
 * has since removed) without that path showing up as a workspace.
 */
export function ensureWorkspaceName(path: string, now: number): string {
  const abs = resolve(path)
  const existing = findWorkspaceByPath(abs)
  if (existing) return existing.name
  const row: WorkspaceRow = {
    path: abs,
    name: availableName(abs),
    lastAccessed: 0,
    registered: false,
  }
  putWorkspaceRow(row, now)
  return row.name
}

/** Remove a workspace from the list while keeping its name and configuration. */
export function unregisterWorkspace(name: string): void {
  const d = configDb()
  if (!d) return
  d.run(
    'UPDATE workspaces SET registered=0, updated_at=? WHERE name=? OR path=?',
    Date.now(),
    name,
    resolve(name),
  )
}

/** Bump the recent-access timestamp (re-sorts the sidebar). No-op for unknown paths. */
export function touchWorkspaceRow(nameOrPath: string, now: number): void {
  const d = configDb()
  if (!d) return
  const row = findWorkspaceByName(nameOrPath) ?? findWorkspaceByPath(nameOrPath)
  if (!row) return
  d.run(
    'UPDATE workspaces SET last_accessed=?, updated_at=? WHERE name=? AND registered=1',
    now,
    now,
    row.name,
  )
}
