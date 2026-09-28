/**
 * Stock-config audit for silently-promoted Codex full access (2026-09-28).
 *
 * Before the sandbox decoupling, `build x never-ask` produced
 * `danger-full-access` — so any config a user picked to quiet approval prompts
 * (or the legacy `full-access` default) ended up with an UNCONSTRAINED host
 * filesystem, without a distinct, observable action recording that choice.
 *
 * This module lists the rows that were promoted WITHOUT an authorization
 * marker, so the user can decide per entry (keep, or reclaim to workspace-write
 * with the Git-metadata compensation). It is one-shot by design: every new
 * write path records the marker (`CodexPolicy.explicitFullAccess`), so only
 * pre-2026-09-28 rows can ever appear. It stays runnable so a workspace moved to
 * another machine can be re-checked.
 *
 * The authorization rule is uniform everywhere: `explicitFullAccess === true`
 * means authorized; anything else (absent, `false`, non-boolean, empty) means
 * NOT. A legacy `full-access` automation whose `mode` is still the STRING token
 * is an explicit user choice and is therefore NOT reported.
 */
import { SESSION_KEYS } from '../../kernel/config/config-schema.js'
import type { Db } from '../../kernel/infra/db.js'

/** One stock row that carries full access without an authorization marker. */
export interface PromotedCodexSandbox {
  readonly kind: 'session' | 'automation'
  readonly id: string
  readonly workspaceName?: string
  /** A short, human-readable description of the offending value. */
  readonly detail: string
}

/** A `session_configs` row as the audit reads it. */
export interface SessionConfigRow {
  readonly session_id: string
  readonly config_key: string
  readonly config_value: string | null
}

/** An `automations` row as the audit reads it. */
export interface AutomationRow {
  readonly id: string
  readonly mode: string | null
  readonly workspace_name: string
}

/** True when a persisted marker value authorizes full access. Strictly `true`. */
export function isExplicitFullAccess(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * Detect promoted sessions from `session_configs` rows: sandbox is
 * `danger-full-access` while no sibling row records the marker as `true`.
 */
export function detectPromotedSessions(rows: readonly SessionConfigRow[]): PromotedCodexSandbox[] {
  const bySession = new Map<string, { sandbox?: string; authorized: boolean }>()
  for (const row of rows) {
    const entry = bySession.get(row.session_id) ?? { authorized: false }
    if (row.config_key === SESSION_KEYS.codexSandboxMode)
      entry.sandbox = row.config_value ?? undefined
    if (row.config_key === SESSION_KEYS.codexExplicitFullAccess) {
      entry.authorized = isExplicitFullAccess(row.config_value)
    }
    bySession.set(row.session_id, entry)
  }
  const promoted: PromotedCodexSandbox[] = []
  for (const [id, entry] of bySession) {
    if (entry.sandbox === 'danger-full-access' && !entry.authorized) {
      promoted.push({
        kind: 'session',
        id,
        detail: 'codexPolicy.sandboxMode=danger-full-access without explicitFullAccess',
      })
    }
  }
  return promoted
}

/**
 * Detect promoted automations from `automations` rows: the `mode` JSON object
 * declares `danger-full-access` without the marker. A legacy STRING token
 * (`'full-access'`) is an explicit choice and is skipped.
 */
export function detectPromotedAutomations(rows: readonly AutomationRow[]): PromotedCodexSandbox[] {
  const promoted: PromotedCodexSandbox[] = []
  for (const row of rows) {
    const raw = row.mode
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A legacy ModeToken string (e.g. 'full-access') is not JSON — explicit.
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const policy = parsed as Record<string, unknown>
    if (policy.sandboxMode !== 'danger-full-access') continue
    if (isExplicitFullAccess(policy.explicitFullAccess)) continue
    promoted.push({
      kind: 'automation',
      id: row.id,
      workspaceName: row.workspace_name,
      detail: 'mode.sandboxMode=danger-full-access without explicitFullAccess',
    })
  }
  return promoted
}

/**
 * Scan the live c3 database for promoted rows. Reads only; never mutates. The
 * caller decides what to show or migrate.
 */
export function auditCodexSandboxPromotions(db: Db): PromotedCodexSandbox[] {
  const sessionRows = db.all<SessionConfigRow>(
    `SELECT session_id, config_key, config_value FROM session_configs
      WHERE config_key IN (?, ?)`,
    SESSION_KEYS.codexSandboxMode,
    SESSION_KEYS.codexExplicitFullAccess,
  )
  // The empty-string filter is applied in JS (an empty `mode` is skipped below),
  // which keeps the SQL free of a quoted literal SQLite would read as an identifier.
  const automationRows = db.all<AutomationRow>('SELECT id, mode, workspace_name FROM automations')
  return [...detectPromotedSessions(sessionRows), ...detectPromotedAutomations(automationRows)]
}

/**
 * Render the audit as an observable, human-readable notice: what was found, why
 * it counts as promoted, and what the user can do. An empty result is still a
 * positive, explicit statement (nothing was silently promoted).
 */
export function formatCodexSandboxAudit(findings: readonly PromotedCodexSandbox[]): string {
  if (findings.length === 0) {
    return '[c3] codex sandbox audit: no silently-promoted full-access rows found.'
  }
  const lines = [
    `[c3] codex sandbox audit: ${findings.length} row(s) carry danger-full-access without an explicit`,
    '[c3]   authorization record. These were promoted by the old build ("stop asking" == "no',
    '[c3]   sandbox"); the new build degrades them to workspace-write + a Git-metadata write',
    '[c3]   whitelist. Keep them as-is by selecting "full access" for the row (which records the',
    '[c3]   authorization), or leave them to be reclaimed.',
  ]
  for (const f of findings) {
    const where = f.workspaceName ? ` @ ${f.workspaceName}` : ''
    lines.push(`[c3]   - ${f.kind} ${f.id}${where}: ${f.detail}`)
  }
  return lines.join('\n')
}
