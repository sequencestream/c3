/**
 * The append-only record of every WRITE an external key attempted.
 *
 * A range-scoped bearer that leaks is not an event anybody can reconstruct after
 * the fact: HTTPS lowers the odds of interception and revocation stops the next
 * call, but neither answers "who, when, which key, which workspace, what". This
 * table is that answer, and it is the reason a write is auditable at all — the
 * intent/discussion ledgers record what CHANGED, never which credential asked.
 *
 * Only non-secret facts are stored. There is deliberately no column for
 * arguments, tool output, the bearer value, the key hash or an authorization
 * header: an audit trail that can leak a credential is a second copy of the
 * credential. `keyId` is the non-secret id already printed in the console, and
 * `ownerSubject` is the account the key belongs to.
 *
 * Append-only in the strict sense: nothing here updates or deletes a row. A
 * revoked key keeps its history, because the history is about what was done
 * while it existed.
 *
 * Writes THROW when the database is unavailable rather than degrading to a
 * no-op. Losing audit coverage silently is exactly the failure mode that would
 * defeat attribution, so the caller must be able to notice; the dispatcher turns
 * that throw into a sanitized operational error and still returns the business
 * result, because refusing legitimate work is not an improvement over an
 * incomplete trail.
 */
import { randomUUID } from 'node:crypto'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

/**
 * What became of one attempted write.
 *
 * The split is by WHERE the call stopped, not by how bad it was: `rejected`
 * never reached the business handler (authorization, schema validation or the
 * ID-ownership check refused it), `failure` did reach it and came back an error
 * or threw, `success` completed. That is what makes a burst of `rejected` rows
 * readable as probing rather than as a broken integration.
 */
export type ExternalMcpAuditResult = 'success' | 'failure' | 'rejected'

/** One audit row as the store hands it back. */
export interface ExternalMcpWriteAudit {
  id: string
  occurredAt: number
  keyId: string
  ownerSubject: string
  /** The workspace the authorization decision was made against — attempted or effective. */
  workspaceName: string
  tool: string
  result: ExternalMcpAuditResult
}

/** What the dispatcher supplies; the id is minted here. */
export type ExternalMcpWriteAuditInput = Omit<ExternalMcpWriteAudit, 'id'>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS external_mcp_write_audits (
  id             TEXT PRIMARY KEY,
  occurred_at    INTEGER NOT NULL,
  key_id         TEXT NOT NULL,
  owner_subject  TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  tool           TEXT NOT NULL,
  result         TEXT NOT NULL CHECK(result IN ('success','failure','rejected'))
);
CREATE INDEX IF NOT EXISTS idx_external_mcp_write_audit_occurred
  ON external_mcp_write_audits(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_mcp_write_audit_key
  ON external_mcp_write_audits(key_id, occurred_at DESC);
`

/**
 * Keyed on the connection, not a boolean: `resetDbForTests` hands out a new
 * connection to a new file, and a plain flag would claim the table exists there.
 */
let schemaReadyFor: Db | null = null

function db(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
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
export function resetExternalMcpAuditStoreForTests(): void {
  schemaReadyFor = null
}

/**
 * Materialize the table at startup. The store creates it on first use anyway;
 * doing it while booting means the first audited call does not pay for DDL, and
 * an unusable database is discovered before it can cost a write its trail.
 */
export function ensureExternalMcpWriteAuditSchema(): boolean {
  return db() !== null
}

/**
 * Append one attempted write. Throws when the row could not be persisted — an
 * unavailable database included — so the caller can report the gap.
 */
export function recordExternalMcpWriteAudit(
  entry: ExternalMcpWriteAuditInput,
): ExternalMcpWriteAudit {
  const d = db()
  if (!d) throw new Error('[c3] 审计库不可用,外部 MCP 写调用未能记录')
  const row: ExternalMcpWriteAudit = { id: randomUUID(), ...entry }
  d.run(
    `INSERT INTO external_mcp_write_audits
       (id, occurred_at, key_id, owner_subject, workspace_name, tool, result)
     VALUES (?,?,?,?,?,?,?)`,
    row.id,
    row.occurredAt,
    row.keyId,
    row.ownerSubject,
    row.workspaceName,
    row.tool,
    row.result,
  )
  return row
}

/**
 * The most recent attempts first. There is no console surface for this yet; it
 * exists so the trail can be read back by an operator query and by the tests
 * that pin what a row may contain.
 */
export function listExternalMcpWriteAudits(limit = 200): ExternalMcpWriteAudit[] {
  const d = db()
  if (!d) return []
  return d
    .all<{
      id: string
      occurred_at: number
      key_id: string
      owner_subject: string
      workspace_name: string
      tool: string
      result: string
    }>(
      `SELECT id, occurred_at, key_id, owner_subject, workspace_name, tool, result
         FROM external_mcp_write_audits
        ORDER BY occurred_at DESC, rowid DESC
        LIMIT ?`,
      limit,
    )
    .map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      keyId: r.key_id,
      ownerSubject: r.owner_subject,
      workspaceName: r.workspace_name,
      tool: r.tool,
      result: r.result as ExternalMcpAuditResult,
    }))
}
