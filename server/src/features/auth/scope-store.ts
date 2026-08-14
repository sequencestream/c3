/**
 * The administrator-managed answer to "which workspaces may this account reach?".
 *
 * Two tables rather than one column, because the model has to be able to say
 * **"selected, and nothing is selected yet"**. A single `workspaces` list would
 * collapse that into the same empty value as "no policy at all", and the two must
 * stay distinguishable — one is a deliberate lockout an administrator typed, the
 * other is an account nobody has configured. Both deny, but only one of them is
 * a state the UI can show as intentional.
 *
 * Default-deny is the whole point of the table existing: an absent policy row
 * grants NOTHING. The two subjects that bypass it — the configured administrator
 * and the synthesized `local` principal — are resolver branches in
 * `authorization.ts`, never rows here. Keeping them out of storage is what stops
 * an administrator from editing away their own recovery access.
 *
 * Not `personalized_configs`: that table is preference state its own subject
 * writes. This is authorization state only an administrator writes, read by the
 * subject it constrains. Sharing a table would put "the user can change it" and
 * "the user must not change it" behind one write path.
 *
 * Detail rows carry a workspace NAME and no foreign key. The registry
 * soft-unregisters (it never deletes a row), and a name that later disappears
 * must degrade to "reaches nothing" rather than cascade-delete a policy an
 * administrator still wants to see. Resolution filters against the live registry,
 * so a stale detail row is inert, not dangerous.
 */
import { configDb, configTx } from '../../kernel/config/config-store.js'
import { bumpPolicyEpoch } from '../../kernel/config/policy-epoch.js'
import type { Db } from '../../kernel/infra/db.js'

/**
 * How a subject's workspace access is expressed. `all` follows the registry —
 * a workspace registered later is included without an edit. `selected` is a
 * fixed name list that never auto-expands.
 */
export type WorkspaceScopeMode = 'all' | 'selected'

/** One subject's stored policy. `workspaces` is meaningful only under `selected`. */
export interface StoredWorkspaceScope {
  subject: string
  mode: WorkspaceScopeMode
  /** The selected workspace names, registry-independent and possibly stale. */
  workspaces: string[]
  updatedAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_workspace_scopes (
  subject    TEXT PRIMARY KEY,
  mode       TEXT NOT NULL CHECK(mode IN ('all','selected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_workspace_scope_items (
  subject        TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (subject, workspace_name)
);
CREATE INDEX IF NOT EXISTS idx_user_workspace_scope_item_workspace
  ON user_workspace_scope_items(workspace_name);
`

/**
 * Keyed on the connection, not a boolean: `resetDbForTests` hands out a new
 * connection to a new file, and a plain flag would claim the tables exist there.
 */
let schemaReadyFor: Db | null = null

function db(): Db | null {
  const d = configDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      d.exec(SCHEMA)
    } catch {
      return null
    }
    schemaReadyFor = d
  }
  return d
}

/** Test hook: forget the "schema ensured" connection (pair with `resetDbForTests`). */
export function resetWorkspaceScopeStoreForTests(): void {
  schemaReadyFor = null
}

/**
 * A subject is an opaque account identity. Only surrounding whitespace is
 * normalized — the comparison against `basic.adminUsername` is case-sensitive
 * everywhere else, and inventing a second casing rule here would let two
 * spellings of one account hold two different policies.
 */
export function normalizeSubject(raw: string): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function toMode(raw: string): WorkspaceScopeMode | null {
  return raw === 'all' || raw === 'selected' ? raw : null
}

function readItems(d: Db, subject: string): string[] {
  return d
    .all<{ workspace_name: string }>(
      'SELECT workspace_name FROM user_workspace_scope_items WHERE subject=? ORDER BY workspace_name',
      subject,
    )
    .map((row) => row.workspace_name)
}

/**
 * One subject's policy, or `null` when it has none — which the resolver reads as
 * "no access", never as "all". An unknown `mode` (a hand-edited row that slipped
 * past the CHECK, a value written by a newer c3) is also `null`: an authorization
 * input c3 cannot interpret must not be interpreted generously.
 */
export function readWorkspaceScope(subject: string): StoredWorkspaceScope | null {
  const normalized = normalizeSubject(subject)
  if (!normalized) return null
  const d = db()
  if (!d) return null
  const row = d.get<{ mode: string; updated_at: number }>(
    'SELECT mode, updated_at FROM user_workspace_scopes WHERE subject=?',
    normalized,
  )
  if (!row) return null
  const mode = toMode(row.mode)
  if (!mode) return null
  return {
    subject: normalized,
    mode,
    workspaces: mode === 'selected' ? readItems(d, normalized) : [],
    updatedAt: row.updated_at,
  }
}

/** Every stored policy, subject-ordered. The roster an administrator screen renders. */
export function listWorkspaceScopes(): StoredWorkspaceScope[] {
  const d = db()
  if (!d) return []
  const out: StoredWorkspaceScope[] = []
  for (const row of d.all<{ subject: string; mode: string; updated_at: number }>(
    'SELECT subject, mode, updated_at FROM user_workspace_scopes ORDER BY subject',
  )) {
    const mode = toMode(row.mode)
    if (!mode) continue
    out.push({
      subject: row.subject,
      mode,
      workspaces: mode === 'selected' ? readItems(d, row.subject) : [],
      updatedAt: row.updated_at,
    })
  }
  return out
}

/**
 * Replace a subject's whole policy — mode and details together — and publish the
 * new epoch in the SAME transaction. Partial application is not expressible: a
 * failure rolls back the policy, the details and the epoch as one, so no session
 * is ever evicted by a write that did not land.
 *
 * Detail names are de-duplicated and stored verbatim; membership in the registry
 * is a resolution-time question, so an administrator can grant a workspace that
 * is momentarily unreadable without the grant being silently dropped.
 */
export function putWorkspaceScope(
  subject: string,
  mode: WorkspaceScopeMode,
  workspaces: readonly string[],
  now: number,
): StoredWorkspaceScope {
  const normalized = normalizeSubject(subject)
  if (!normalized) throw new Error('[c3] workspace scope needs a non-empty subject')
  // Materialize BEFORE opening the transaction: DDL inside it would be rolled
  // back with the write it was meant to enable.
  if (!db()) throw new Error('[c3] 配置数据库不可用,无法保存工作区范围')
  const names =
    mode === 'selected'
      ? [...new Set(workspaces.map((w) => w.trim()).filter((w) => w.length > 0))].sort()
      : []
  return configTx((d) => {
    d.run(
      `INSERT INTO user_workspace_scopes (subject, mode, created_at, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(subject) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at`,
      normalized,
      mode,
      now,
      now,
    )
    d.run('DELETE FROM user_workspace_scope_items WHERE subject=?', normalized)
    for (const name of names) {
      d.run(
        'INSERT INTO user_workspace_scope_items (subject, workspace_name, created_at) VALUES (?,?,?)',
        normalized,
        name,
        now,
      )
    }
    bumpPolicyEpoch()
    return { subject: normalized, mode, workspaces: names, updatedAt: now }
  })
}

/**
 * Drop a subject's policy entirely — the account keeps existing and reaches
 * nothing. Returns whether a row was actually removed; only a real removal bumps
 * the epoch, so deleting an absent policy cannot churn every live session.
 */
export function deleteWorkspaceScope(subject: string): boolean {
  const normalized = normalizeSubject(subject)
  if (!normalized) return false
  if (!db()) return false
  return configTx((d) => {
    const existing = d.get<{ subject: string }>(
      'SELECT subject FROM user_workspace_scopes WHERE subject=?',
      normalized,
    )
    if (!existing) return false
    d.run('DELETE FROM user_workspace_scope_items WHERE subject=?', normalized)
    d.run('DELETE FROM user_workspace_scopes WHERE subject=?', normalized)
    bumpPolicyEpoch()
    return true
  })
}

/**
 * Ensure the scope tables exist. The resolver denies by default, so a database
 * that never materialized them behaves identically to one where every account is
 * unconfigured — but materializing at startup keeps an administrator screen from
 * reporting "unavailable" the first time it reads.
 */
export function ensureWorkspaceScopeSchema(): boolean {
  return db() !== null
}
