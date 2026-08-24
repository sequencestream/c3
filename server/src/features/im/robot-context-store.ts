/**
 * IM robot Conversations and bounded IM-visible context.
 *
 * Conversation identity includes binding + subject + scope_hash, so different
 * senders never share recoverable context and binding/revoke/ACL changes cut it.
 * Context bodies are bounded: credential-shape refuse, 4000 code points per
 * answer, 50 turns, 30-day hard delete. Audit rows (robot-turn-store) never
 * carry a body. Old sessions without binding dimensions are cut, not migrated.
 */
import { randomUUID } from 'node:crypto'
import {
  ROBOT_CONTEXT_MAX_CODEPOINTS,
  ROBOT_CONTEXT_MAX_TURNS,
  ROBOT_CONTEXT_RETENTION_MS,
  type ImPlatform,
  type VendorId,
} from '@ccc/shared/protocol'
import type { Db } from '../../kernel/infra/db.js'
import { truncateCodePoints } from './inbound-guard.js'
import type { ConversationIdentity } from './thread-key.js'
import { db, now, requireDb, tx, type SqlParam } from './robot-db.js'

/** Soft budget for recovery seed size (Unicode code points across all turns). */
export const ROBOT_CONTEXT_RECOVERY_BUDGET = 80_000

// ---- Conversations ----

export interface RobotConversation {
  platform: ImPlatform
  robotId: string
  threadKey: string
  senderId: string
  bindingId: string
  subject: string
  scopeHash: string
  chatId: string
  sessionId: string | null
  vendor: VendorId
  contextRevision: number
  turnCount: number
  createdAt: number
  lastActiveAt: number
}

interface ConversationRow {
  platform: string
  robot_id: string
  thread_key: string
  sender_id: string
  binding_id: string
  subject: string
  scope_hash: string
  chat_id: string
  session_id: string | null
  vendor: string
  context_revision: number
  turn_count: number
  created_at: number
  last_active_at: number
}

const CONV_WHERE =
  'platform = ? AND robot_id = ? AND thread_key = ? AND sender_id = ? AND binding_id = ? AND subject = ? AND scope_hash = ?'

function convParams(id: ConversationIdentity): SqlParam[] {
  return [
    id.platform,
    id.robotId,
    id.threadKey,
    id.senderId,
    id.bindingId,
    id.subject,
    id.scopeHash,
  ]
}

function toConversation(r: ConversationRow): RobotConversation {
  return {
    platform: r.platform as ImPlatform,
    robotId: r.robot_id,
    threadKey: r.thread_key,
    senderId: r.sender_id,
    bindingId: r.binding_id,
    subject: r.subject,
    scopeHash: r.scope_hash,
    chatId: r.chat_id,
    sessionId: r.session_id,
    vendor: r.vendor as VendorId,
    contextRevision: r.context_revision,
    turnCount: r.turn_count,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
  }
}

export function getConversation(id: ConversationIdentity): RobotConversation | null {
  const d = db()
  if (!d) return null
  const row = d.get<ConversationRow>(
    `SELECT * FROM im_robot_threads WHERE ${CONV_WHERE}`,
    ...convParams(id),
  )
  return row ? toConversation(row) : null
}

function ensureConversation(
  d: Db,
  input: ConversationIdentity & { chatId: string; vendor: VendorId },
): RobotConversation {
  const existing = getConversation(input)
  const t = now()
  if (!existing) {
    d.run(
      `INSERT INTO im_robot_threads
         (platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash,
          chat_id, session_id, vendor, context_revision, turn_count, created_at, last_active_at)
       VALUES (?,?,?,?,?,?,?,?,NULL,?,0,0,?,?)`,
      input.platform,
      input.robotId,
      input.threadKey,
      input.senderId,
      input.bindingId,
      input.subject,
      input.scopeHash,
      input.chatId,
      input.vendor,
      t,
      t,
    )
    return {
      platform: input.platform,
      robotId: input.robotId,
      threadKey: input.threadKey,
      senderId: input.senderId,
      bindingId: input.bindingId,
      subject: input.subject,
      scopeHash: input.scopeHash,
      chatId: input.chatId,
      sessionId: null,
      vendor: input.vendor,
      contextRevision: 0,
      turnCount: 0,
      createdAt: t,
      lastActiveAt: t,
    }
  }
  d.run(
    `UPDATE im_robot_threads SET chat_id = ?, last_active_at = ? WHERE ${CONV_WHERE}`,
    input.chatId,
    t,
    ...convParams(input),
  )
  return { ...existing, chatId: input.chatId, lastActiveAt: t }
}

// ---- Context turns ----

export type ContextTurnStatus = 'pending' | 'committed' | 'failed'

export interface CommittedContextTurn {
  userText: string
  assistantText: string
  seq: number
  committedAt: number
}

export type ClaimResult =
  | { kind: 'duplicate' }
  | { kind: 'claimed'; conversation: RobotConversation; contextTurnId: string }
  | { kind: 'busy' }

const UNBOUND_SENTINEL = '_'

/**
 * Dedup-only claim for identity-gate messages (no recoverable Conversation).
 * Inserts a failed context row with sentinel binding fields.
 */
export function claimGateMessage(input: {
  platform: ImPlatform
  robotId: string
  threadKey: string
  senderId: string
  messageId: string
}): 'duplicate' | 'claimed' {
  const d = requireDb()
  return tx(d, () => {
    const already = d.get<{ n: number }>(
      `SELECT 1 AS n FROM im_robot_context_turns
       WHERE platform = ? AND robot_id = ? AND in_message_id = ?`,
      input.platform,
      input.robotId,
      input.messageId,
    )
    if (already) return 'duplicate'
    try {
      d.run(
        `INSERT INTO im_robot_context_turns
           (id, platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash,
            in_message_id, status, user_text, assistant_text, seq, committed_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'failed','','',NULL,NULL,?)`,
        randomUUID(),
        input.platform,
        input.robotId,
        input.threadKey,
        input.senderId,
        UNBOUND_SENTINEL,
        UNBOUND_SENTINEL,
        UNBOUND_SENTINEL,
        input.messageId,
        now(),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE/i.test(msg)) return 'duplicate'
      throw err
    }
    return 'claimed'
  })
}

/**
 * Atomically claim an inbound messageId for one Conversation. Duplicate
 * (platform, robotId, messageId) returns `duplicate` without a second run or
 * outbound. When `forRun` is false (conversation already in flight), reserves
 * the messageId as a failed row for dedup only — does not heal orphans or
 * clear the live session cache.
 */
export function claimInboundMessage(
  input: ConversationIdentity & {
    chatId: string
    vendor: VendorId
    messageId: string
    /** Default true. False = busy-path dedup claim (failed row, no orphan heal). */
    forRun?: boolean
  },
): ClaimResult {
  const d = requireDb()
  const forRun = input.forRun !== false
  return tx(d, () => {
    const conversation = ensureConversation(d, input)
    // Dedup before orphan heal — a redelivered messageId must not fail a live pending.
    const already = d.get<{ n: number }>(
      `SELECT 1 AS n FROM im_robot_context_turns
       WHERE platform = ? AND robot_id = ? AND in_message_id = ?`,
      input.platform,
      input.robotId,
      input.messageId,
    )
    if (already) return { kind: 'duplicate' }

    if (forRun) {
      const orphan = d.get<{ id: string }>(
        `SELECT id FROM im_robot_context_turns
         WHERE ${CONV_WHERE} AND status = 'pending'`,
        ...convParams(input),
      )
      if (orphan) {
        d.run(
          `UPDATE im_robot_context_turns
             SET status = 'failed', user_text = '', assistant_text = ''
           WHERE id = ?`,
          orphan.id,
        )
        d.run(
          `UPDATE im_robot_threads SET session_id = NULL, last_active_at = ?
           WHERE ${CONV_WHERE}`,
          now(),
          ...convParams(input),
        )
      }
    }

    const id = randomUUID()
    const status = forRun ? 'pending' : 'failed'
    try {
      d.run(
        `INSERT INTO im_robot_context_turns
           (id, platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash,
            in_message_id, status, user_text, assistant_text, seq, committed_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'','',NULL,NULL,?)`,
        id,
        input.platform,
        input.robotId,
        input.threadKey,
        input.senderId,
        input.bindingId,
        input.subject,
        input.scopeHash,
        input.messageId,
        status,
        now(),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE/i.test(msg)) return { kind: 'duplicate' }
      throw err
    }
    if (!forRun) return { kind: 'busy' }
    const fresh = getConversation(input) ?? conversation
    return { kind: 'claimed', conversation: fresh, contextTurnId: id }
  })
}

/**
 * Converge leftover pending rows after restart; clear their session caches.
 * Registered as the post-ensure step by `robot-schema.ts`.
 */
export function failStalePendingContextTurns(d: Db): void {
  const pending = d.all<{
    id: string
    platform: string
    robot_id: string
    thread_key: string
    sender_id: string
    binding_id: string
    subject: string
    scope_hash: string
  }>(
    `SELECT id, platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash
     FROM im_robot_context_turns WHERE status = 'pending'`,
  )
  if (pending.length === 0) return
  tx(d, () => {
    for (const row of pending) {
      d.run(
        `UPDATE im_robot_context_turns
           SET status = 'failed', user_text = '', assistant_text = ''
         WHERE id = ?`,
        row.id,
      )
      d.run(
        `UPDATE im_robot_threads SET session_id = NULL, last_active_at = ?
         WHERE ${CONV_WHERE}`,
        now(),
        row.platform,
        row.robot_id,
        row.thread_key,
        row.sender_id,
        row.binding_id,
        row.subject,
        row.scope_hash,
      )
    }
  })
}

export function failContextTurn(contextTurnId: string): void {
  const d = requireDb()
  tx(d, () => {
    const row = d.get<{
      platform: string
      robot_id: string
      thread_key: string
      sender_id: string
      binding_id: string
      subject: string
      scope_hash: string
      status: string
    }>(
      `SELECT platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash, status
       FROM im_robot_context_turns WHERE id = ?`,
      contextTurnId,
    )
    if (!row || row.status !== 'pending') return
    d.run(
      `UPDATE im_robot_context_turns
         SET status = 'failed', user_text = '', assistant_text = ''
       WHERE id = ?`,
      contextTurnId,
    )
    d.run(
      `UPDATE im_robot_threads SET session_id = NULL, last_active_at = ?
       WHERE ${CONV_WHERE}`,
      now(),
      row.platform,
      row.robot_id,
      row.thread_key,
      row.sender_id,
      row.binding_id,
      row.subject,
      row.scope_hash,
    )
  })
}

/**
 * Commit a delivered turn into recoverable context and bind the native session
 * cache. Prunes by capacity and retention in the same transaction.
 */
export function commitContextTurn(input: {
  contextTurnId: string
  userText: string
  assistantText: string
  sessionId: string
  vendor: VendorId
}): void {
  const d = requireDb()
  const assistant = truncateCodePoints(input.assistantText, ROBOT_CONTEXT_MAX_CODEPOINTS)
  tx(d, () => {
    const row = d.get<{
      platform: string
      robot_id: string
      thread_key: string
      sender_id: string
      binding_id: string
      subject: string
      scope_hash: string
      status: string
    }>(
      `SELECT platform, robot_id, thread_key, sender_id, binding_id, subject, scope_hash, status
       FROM im_robot_context_turns WHERE id = ?`,
      input.contextTurnId,
    )
    if (!row || row.status !== 'pending') return

    const identity: ConversationIdentity = {
      platform: row.platform as ImPlatform,
      robotId: row.robot_id,
      threadKey: row.thread_key,
      senderId: row.sender_id,
      bindingId: row.binding_id,
      subject: row.subject,
      scopeHash: row.scope_hash,
    }
    const t = now()
    const maxSeq = d.get<{ m: number | null }>(
      `SELECT MAX(seq) AS m FROM im_robot_context_turns
       WHERE ${CONV_WHERE} AND status = 'committed'`,
      ...convParams(identity),
    )
    const seq = (maxSeq?.m ?? 0) + 1

    d.run(
      `UPDATE im_robot_context_turns
         SET status = 'committed', user_text = ?, assistant_text = ?, seq = ?, committed_at = ?
       WHERE id = ? AND status = 'pending'`,
      input.userText,
      assistant,
      seq,
      t,
      input.contextTurnId,
    )

    d.run(
      `UPDATE im_robot_threads
         SET session_id = ?, vendor = ?,
             context_revision = context_revision + 1,
             turn_count = turn_count + 1,
             last_active_at = ?
       WHERE ${CONV_WHERE}`,
      input.sessionId,
      input.vendor,
      t,
      ...convParams(identity),
    )

    pruneConversationContext(d, identity)
  })
}

function pruneConversationContext(d: Db, id: ConversationIdentity): void {
  const cutoff = now() - ROBOT_CONTEXT_RETENTION_MS
  d.run(
    `DELETE FROM im_robot_context_turns
     WHERE ${CONV_WHERE}
       AND status = 'committed' AND committed_at IS NOT NULL AND committed_at < ?`,
    ...convParams(id),
    cutoff,
  )

  const committed = d.all<{ id: string; seq: number }>(
    `SELECT id, seq FROM im_robot_context_turns
     WHERE ${CONV_WHERE} AND status = 'committed'
     ORDER BY seq ASC, id ASC`,
    ...convParams(id),
  )
  const overflow = committed.length - ROBOT_CONTEXT_MAX_TURNS
  if (overflow <= 0) return
  const toDelete = committed.slice(0, overflow)
  for (const row of toDelete) {
    d.run('DELETE FROM im_robot_context_turns WHERE id = ?', row.id)
  }
  d.run(
    `UPDATE im_robot_threads SET turn_count = ? WHERE ${CONV_WHERE}`,
    committed.length - overflow,
    ...convParams(id),
  )
}

/**
 * Load committed IM-visible turns for recovery. Applies retention prune first,
 * then trims from the earliest complete turn if the soft budget is exceeded.
 */
export function loadCommittedContext(id: ConversationIdentity): CommittedContextTurn[] {
  const d = requireDb()
  return tx(d, () => {
    pruneConversationContext(d, id)
    const rows = d.all<{
      user_text: string
      assistant_text: string
      seq: number
      committed_at: number
    }>(
      `SELECT user_text, assistant_text, seq, committed_at FROM im_robot_context_turns
       WHERE ${CONV_WHERE} AND status = 'committed'
       ORDER BY seq ASC, id ASC`,
      ...convParams(id),
    )
    const turns: CommittedContextTurn[] = rows.map((r) => ({
      userText: r.user_text,
      assistantText: r.assistant_text,
      seq: r.seq,
      committedAt: r.committed_at,
    }))
    return trimByBudget(turns)
  })
}

function trimByBudget(turns: CommittedContextTurn[]): CommittedContextTurn[] {
  let total = 0
  for (const t of turns) {
    total += Array.from(t.userText).length + Array.from(t.assistantText).length
  }
  if (total <= ROBOT_CONTEXT_RECOVERY_BUDGET) return turns
  const kept = [...turns]
  while (kept.length > 0) {
    total = 0
    for (const t of kept) {
      total += Array.from(t.userText).length + Array.from(t.assistantText).length
    }
    if (total <= ROBOT_CONTEXT_RECOVERY_BUDGET) break
    kept.shift() // drop earliest complete pair — never split a pair
  }
  return kept
}

/**
 * Verified native session reference for resume, or null when the cache must be
 * discarded and the turn must start from the DB seed.
 */
export function resolvedSessionRef(
  conversation: RobotConversation,
  robotVendor: VendorId,
): { sessionId: string; contextRevision: number } | null {
  if (!conversation.sessionId) return null
  if (conversation.vendor !== robotVendor) return null
  return { sessionId: conversation.sessionId, contextRevision: conversation.contextRevision }
}
