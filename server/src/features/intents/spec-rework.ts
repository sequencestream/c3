/**
 * Human spec rework via IM — separate from machine reviewer submit_spec_review.
 */
import { randomUUID } from 'node:crypto'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'
import { getIntent, isStoreAvailable } from './store.js'
import { getEventByRequestId, updateStatus } from '../user-involve/store.js'
import { readSpecFingerprint } from './spec-review.js'
import { resolveWorkspaceRoot } from '../../state.js'

export type HumanSpecReworkOutcome = 'applied' | 'already_applied' | 'stale' | 'refused'

const REWORK_MIGRATION = 'intents.human_spec_rework.v1'

function ensureReworkColumns(d: Db): void {
  const cols = new Set(d.all<{ name: string }>('PRAGMA table_info(intents)').map((r) => r.name))
  if (!cols.has('spec_human_rework_fingerprint')) {
    d.exec('ALTER TABLE intents ADD COLUMN spec_human_rework_fingerprint TEXT')
  }
  if (!cols.has('spec_human_rework_actor')) {
    d.exec('ALTER TABLE intents ADD COLUMN spec_human_rework_actor TEXT')
  }
  if (!cols.has('spec_human_rework_at')) {
    d.exec('ALTER TABLE intents ADD COLUMN spec_human_rework_at INTEGER')
  }
  if (!cols.has('spec_human_rework_idempotency')) {
    d.exec('ALTER TABLE intents ADD COLUMN spec_human_rework_idempotency TEXT')
  }
}

function db(): Db | null {
  if (!isStoreAvailable() || !isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  ensureReworkColumns(d)
  return d
}

export function requestHumanSpecRework(input: {
  intentId: string
  specFingerprint: string
  actor: string
  idempotencyKey: string
}): HumanSpecReworkOutcome {
  const d = db()
  if (!d) return 'refused'
  const row = d.get<{
    id: string
    workspace_name: string
    spec_path: string | null
    spec_status: string
    spec_human_rework_idempotency: string | null
  }>(
    'SELECT id, workspace_name, spec_path, spec_status, spec_human_rework_idempotency FROM intents WHERE id=?',
    input.intentId,
  )
  if (!row || row.spec_status !== 'pending') return 'stale'
  if (row.spec_human_rework_idempotency === input.idempotencyKey) return 'already_applied'
  const ws = resolveWorkspaceRoot(row.workspace_name)
  if (!ws || !row.spec_path) return 'stale'
  const live = readSpecFingerprint(ws, row.spec_path)
  if (!live || live !== input.specFingerprint) return 'stale'
  const t = Date.now()
  d.run(
    `UPDATE intents SET spec_human_rework_fingerprint=?, spec_human_rework_actor=?,
       spec_human_rework_at=?, spec_human_rework_idempotency=?, spec_review_machine_blocked=1,
       updated_at=? WHERE id=?`,
    input.specFingerprint,
    input.actor,
    t,
    input.idempotencyKey,
    t,
    input.intentId,
  )
  const todo = getEventByRequestId(`spec:${input.intentId}:${input.specFingerprint}`)
  if (todo) updateStatus(todo.id, 'canceled')
  return 'applied'
}

/** Test hook: ensure rework columns exist. */
export function ensureHumanSpecReworkSchema(): void {
  db()
}
