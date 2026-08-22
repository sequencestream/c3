/**
 * One-shot todo answer tokens for IM L2 directed responses.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  TODO_TOKEN_PREFIX,
  type RobotWritableCapability,
  type TodoTokenResult,
} from '@ccc/shared/protocol'
import {
  getDb,
  hasMigration,
  isDbAvailable,
  markMigration,
  type Db,
} from '../../kernel/infra/db.js'

const TOKEN_TTL_MS = 30 * 60 * 1000
const TOKEN_BYTES = 24
const TOKENS_MIGRATION = 'robots.todo_tokens.v1'

let nowFn: () => number = () => Date.now()
let schemaReadyFor: Db | null = null
let schemaFailed = false

export function setTodoTokenStoreClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now())
}

export function resetTodoTokenStoreForTests(): void {
  schemaReadyFor = null
  schemaFailed = false
  nowFn = () => Date.now()
}

function now(): number {
  return nowFn()
}

const TOKENS_TABLE = `
CREATE TABLE IF NOT EXISTS im_todo_tokens (
  id                   TEXT PRIMARY KEY,
  token_hash           TEXT NOT NULL UNIQUE,
  robot_id             TEXT NOT NULL,
  todo_id              TEXT NOT NULL,
  binding_id           TEXT NOT NULL,
  actor_sender_id      TEXT NOT NULL,
  actor_subject        TEXT NOT NULL,
  workspace_name       TEXT NOT NULL,
  capability           TEXT NOT NULL,
  todo_fingerprint     TEXT NOT NULL,
  config_hash          TEXT NOT NULL,
  expires_at           INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','executing','succeeded','refused','expired','cancelled')),
  answer_id            TEXT,
  idempotency_key      TEXT,
  result_json          TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  FOREIGN KEY (robot_id) REFERENCES im_robots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_im_todo_tokens_todo ON im_todo_tokens(todo_id, status);
CREATE INDEX IF NOT EXISTS idx_im_todo_tokens_robot_actor ON im_todo_tokens(robot_id, actor_subject, status);`

interface TokenRow {
  id: string
  token_hash: string
  robot_id: string
  todo_id: string
  binding_id: string
  actor_sender_id: string
  actor_subject: string
  workspace_name: string
  capability: string
  todo_fingerprint: string
  config_hash: string
  expires_at: number
  status: string
  answer_id: string | null
  idempotency_key: string | null
  result_json: string | null
  created_at: number
  updated_at: number
}

export interface IssuedTodoToken {
  tokenId: string
  plaintext: string
  expiresAt: number
}

export interface TokenClaimResult {
  ok: boolean
  result: TodoTokenResult
  tokenId?: string
  answerId?: string
  idempotencyKey?: string
  storedResult?: unknown
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

function generatePlaintext(): string {
  return TODO_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url')
}

function migrateTokens(d: Db): void {
  if (hasMigration(d, TOKENS_MIGRATION)) return
  d.exec(TOKENS_TABLE)
  markMigration(d, TOKENS_MIGRATION)
}

function ensureSchema(d: Db): void {
  migrateTokens(d)
}

function db(): Db | null {
  if (schemaFailed) return null
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      ensureSchema(d)
    } catch (err) {
      schemaFailed = true
      schemaReadyFor = null
      console.error('[c3][im] todo token schema failed:', err instanceof Error ? err.message : err)
      return null
    }
    schemaReadyFor = d
  }
  return d
}

export function isTodoTokenStoreAvailable(): boolean {
  return db() !== null
}

export function ensureTodoTokenSchema(): boolean {
  return db() !== null
}

export function cancelPendingTokensForTodo(
  robotId: string,
  todoId: string,
  actorSubject: string,
): void {
  const d = db()
  if (!d) return
  const t = now()
  d.run(
    `UPDATE im_todo_tokens SET status = 'cancelled', updated_at = ?
     WHERE robot_id = ? AND todo_id = ? AND actor_subject = ? AND status = 'pending'`,
    t,
    robotId,
    todoId,
    actorSubject,
  )
}

export function issueTodoToken(input: {
  robotId: string
  todoId: string
  bindingId: string
  actorSenderId: string
  actorSubject: string
  workspaceName: string
  capability: RobotWritableCapability
  todoFingerprint: string
  configHash: string
}): IssuedTodoToken | null {
  const d = db()
  if (!d) return null
  cancelPendingTokensForTodo(input.robotId, input.todoId, input.actorSubject)
  const plaintext = generatePlaintext()
  const tokenHash = hashToken(plaintext)
  const t = now()
  const expiresAt = t + TOKEN_TTL_MS
  const id = randomUUID()
  d.run(
    `INSERT INTO im_todo_tokens
       (id, token_hash, robot_id, todo_id, binding_id, actor_sender_id, actor_subject,
        workspace_name, capability, todo_fingerprint, config_hash, expires_at, status,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
    id,
    tokenHash,
    input.robotId,
    input.todoId,
    input.bindingId,
    input.actorSenderId,
    input.actorSubject,
    input.workspaceName,
    input.capability,
    input.todoFingerprint,
    input.configHash,
    expiresAt,
    t,
    t,
  )
  return { tokenId: id, plaintext, expiresAt }
}

export function lookupTokenByPlaintext(plaintext: string): TokenRow | null {
  const d = db()
  if (!d) return null
  const hash = hashToken(plaintext)
  return d.get<TokenRow>('SELECT * FROM im_todo_tokens WHERE token_hash = ?', hash) ?? null
}

export function claimTokenForExecution(input: {
  tokenId: string
  answerId: string
  idempotencyKey: string
}): TokenClaimResult {
  const d = db()
  if (!d) return { ok: false, result: 'store_unavailable' }
  const row = d.get<TokenRow>('SELECT * FROM im_todo_tokens WHERE id = ?', input.tokenId)
  if (!row) return { ok: false, result: 'unavailable' }
  if (row.status === 'succeeded' || row.status === 'refused') {
    if (row.answer_id === input.answerId && row.result_json) {
      try {
        return {
          ok: true,
          result: 'already_applied',
          tokenId: row.id,
          answerId: row.answer_id,
          idempotencyKey: row.idempotency_key ?? undefined,
          storedResult: JSON.parse(row.result_json),
        }
      } catch {
        return { ok: true, result: 'already_applied', tokenId: row.id }
      }
    }
    return { ok: false, result: 'consumed' }
  }
  if (row.status === 'cancelled') return { ok: false, result: 'cancelled' }
  if (row.status === 'expired' || row.expires_at <= now()) {
    d.run(
      "UPDATE im_todo_tokens SET status = 'expired', updated_at = ? WHERE id = ?",
      now(),
      row.id,
    )
    return { ok: false, result: 'expired', tokenId: row.id }
  }
  if (row.status === 'executing') {
    if (row.answer_id === input.answerId) {
      return { ok: true, result: 'already_applied', tokenId: row.id, answerId: input.answerId }
    }
    return { ok: false, result: 'consumed' }
  }
  const t = now()
  d.run(
    `UPDATE im_todo_tokens SET status = 'executing', answer_id = ?, idempotency_key = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    input.answerId,
    input.idempotencyKey,
    t,
    input.tokenId,
  )
  const updated = d.get<TokenRow>('SELECT * FROM im_todo_tokens WHERE id = ?', input.tokenId)
  if (!updated || updated.status !== 'executing') {
    return { ok: false, result: 'consumed' }
  }
  return {
    ok: true,
    result: 'applied',
    tokenId: updated.id,
    answerId: input.answerId,
    idempotencyKey: input.idempotencyKey,
  }
}

export function finalizeTokenResult(
  tokenId: string,
  status: 'succeeded' | 'refused',
  result: unknown,
): void {
  const d = db()
  if (!d) return
  d.run(
    `UPDATE im_todo_tokens SET status = ?, result_json = ?, updated_at = ? WHERE id = ?`,
    status,
    JSON.stringify(result),
    now(),
    tokenId,
  )
}

export type { TokenRow }
