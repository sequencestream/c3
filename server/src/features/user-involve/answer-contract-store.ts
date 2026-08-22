/**
 * Todo answer contracts — frozen actor, answers, and domain action payloads.
 */
import { randomUUID } from 'node:crypto'
import type { RobotWritableCapability, TodoAnswerOption } from '@ccc/shared/protocol'
import {
  getDb,
  hasMigration,
  isDbAvailable,
  markMigration,
  type Db,
} from '../../kernel/infra/db.js'

const CONTRACTS_MIGRATION = 'user_involve.answer_contracts.v1'

let nowFn: () => number = () => Date.now()
let schemaReadyFor: Db | null = null

export function resetAnswerContractStoreForTests(): void {
  schemaReadyFor = null
  nowFn = () => Date.now()
}

function now(): number {
  return nowFn()
}

const TABLE = `
CREATE TABLE IF NOT EXISTS im_todo_answer_contracts (
  todo_id              TEXT PRIMARY KEY,
  capability           TEXT NOT NULL
                       CHECK(capability IN ('queue_respond','automation_control','annotate')),
  actor_subject        TEXT NOT NULL,
  workspace_name       TEXT NOT NULL,
  object_type          TEXT NOT NULL,
  object_id            TEXT NOT NULL,
  todo_fingerprint     TEXT NOT NULL,
  answers_json         TEXT NOT NULL,
  domain_action_json   TEXT NOT NULL,
  assignee_subject     TEXT,
  claimed_at           INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_im_todo_contracts_actor ON im_todo_answer_contracts(actor_subject);`

export interface DomainActionPayload {
  kind: string
  [key: string]: unknown
}

export interface AnswerContract {
  todoId: string
  capability: RobotWritableCapability
  actorSubject: string
  workspaceName: string
  objectType: string
  objectId: string
  todoFingerprint: string
  answers: TodoAnswerOption[]
  domainAction: DomainActionPayload
  assigneeSubject: string | null
  claimedAt: number | null
}

interface Row {
  todo_id: string
  capability: string
  actor_subject: string
  workspace_name: string
  object_type: string
  object_id: string
  todo_fingerprint: string
  answers_json: string
  domain_action_json: string
  assignee_subject: string | null
  claimed_at: number | null
  created_at: number
  updated_at: number
}

function toContract(row: Row): AnswerContract {
  return {
    todoId: row.todo_id,
    capability: row.capability as RobotWritableCapability,
    actorSubject: row.actor_subject,
    workspaceName: row.workspace_name,
    objectType: row.object_type,
    objectId: row.object_id,
    todoFingerprint: row.todo_fingerprint,
    answers: JSON.parse(row.answers_json) as TodoAnswerOption[],
    domainAction: JSON.parse(row.domain_action_json) as DomainActionPayload,
    assigneeSubject: row.assignee_subject,
    claimedAt: row.claimed_at,
  }
}

function ensureSchema(d: Db): void {
  if (hasMigration(d, CONTRACTS_MIGRATION)) return
  d.exec(TABLE)
  markMigration(d, CONTRACTS_MIGRATION)
}

function db(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    ensureSchema(d)
    schemaReadyFor = d
  }
  return d
}

export function upsertAnswerContract(input: {
  todoId: string
  capability: RobotWritableCapability
  actorSubject: string
  workspaceName: string
  objectType: string
  objectId: string
  todoFingerprint: string
  answers: TodoAnswerOption[]
  domainAction: DomainActionPayload
}): AnswerContract | null {
  const d = db()
  if (!d) return null
  const t = now()
  d.run(
    `INSERT INTO im_todo_answer_contracts
       (todo_id, capability, actor_subject, workspace_name, object_type, object_id,
        todo_fingerprint, answers_json, domain_action_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(todo_id) DO UPDATE SET
       capability=excluded.capability,
       actor_subject=excluded.actor_subject,
       workspace_name=excluded.workspace_name,
       object_type=excluded.object_type,
       object_id=excluded.object_id,
       todo_fingerprint=excluded.todo_fingerprint,
       answers_json=excluded.answers_json,
       domain_action_json=excluded.domain_action_json,
       updated_at=excluded.updated_at`,
    input.todoId,
    input.capability,
    input.actorSubject,
    input.workspaceName,
    input.objectType,
    input.objectId,
    input.todoFingerprint,
    JSON.stringify(input.answers),
    JSON.stringify(input.domainAction),
    t,
    t,
  )
  return getAnswerContract(input.todoId)
}

export function getAnswerContract(todoId: string): AnswerContract | null {
  const d = db()
  if (!d) return null
  const row = d.get<Row>('SELECT * FROM im_todo_answer_contracts WHERE todo_id = ?', todoId)
  return row ? toContract(row) : null
}

export function claimTodoAssignee(
  todoId: string,
  actorSubject: string,
  idempotencyKey: string,
): {
  ok: boolean
  alreadyApplied?: boolean
} {
  const d = db()
  if (!d) return { ok: false }
  const row = d.get<Row>('SELECT * FROM im_todo_answer_contracts WHERE todo_id = ?', todoId)
  if (!row || row.actor_subject !== actorSubject) return { ok: false }
  if (row.assignee_subject === actorSubject) return { ok: true, alreadyApplied: true }
  if (row.assignee_subject && row.assignee_subject !== actorSubject) return { ok: false }
  const t = now()
  d.run(
    'UPDATE im_todo_answer_contracts SET assignee_subject = ?, claimed_at = ?, updated_at = ? WHERE todo_id = ?',
    actorSubject,
    t,
    t,
    todoId,
  )
  void idempotencyKey
  return { ok: true }
}

export function deleteAnswerContract(todoId: string): void {
  const d = db()
  if (!d) return
  d.run('DELETE FROM im_todo_answer_contracts WHERE todo_id = ?', todoId)
}
