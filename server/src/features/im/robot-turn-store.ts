/**
 * IM robot turn audit: one metadata-only row per outbound attempt in
 * `im_robot_turns`. Records that a turn happened and its shape — never the
 * message bodies, which live only in the bounded context store.
 */
import { randomUUID } from 'node:crypto'
import type { ImInputRejectReason, ImRobotTurnLog, ImTurnOutcome } from '@ccc/shared/protocol'
import { db, now, requireDb } from './robot-db.js'

interface TurnRow {
  id: string
  robot_id: string
  thread_key: string
  chat_id: string
  sender_id: string
  session_id: string | null
  started_at: number
  finished_at: number | null
  outcome: string | null
  reject_reason: string | null
  outbound_chars: number
  error: string | null
}

export function beginTurn(input: {
  robotId: string
  threadKey: string
  chatId: string
  senderId: string
  messageId: string
}): string {
  const d = requireDb()
  const id = randomUUID()
  d.run(
    `INSERT INTO im_robot_turns
       (id, robot_id, thread_key, chat_id, sender_id, in_message_id, session_id,
        started_at, finished_at, outcome, reject_reason, outbound_chars, out_message_id, error)
     VALUES (?,?,?,?,?,?,NULL,?,NULL,NULL,NULL,0,NULL,NULL)`,
    id,
    input.robotId,
    input.threadKey,
    input.chatId,
    input.senderId,
    input.messageId,
    now(),
  )
  return id
}

export function finishTurn(
  turnId: string,
  result: {
    outcome: ImTurnOutcome
    sessionId?: string | null
    outboundChars?: number
    outMessageId?: string | null
    error?: string | null
    rejectReason?: ImInputRejectReason | null
  },
): void {
  const d = requireDb()
  d.run(
    `UPDATE im_robot_turns
       SET finished_at = ?, outcome = ?, session_id = ?, outbound_chars = ?,
           out_message_id = ?, error = ?, reject_reason = ?
     WHERE id = ?`,
    now(),
    result.outcome,
    result.sessionId ?? null,
    result.outboundChars ?? 0,
    result.outMessageId ?? null,
    result.error ?? null,
    result.rejectReason ?? null,
    turnId,
  )
}

export function listTurns(robotId: string, limit = 50): ImRobotTurnLog[] {
  const d = db()
  if (!d) return []
  return d
    .all<TurnRow>(
      'SELECT * FROM im_robot_turns WHERE robot_id = ? ORDER BY started_at DESC LIMIT ?',
      robotId,
      limit,
    )
    .map((r) => ({
      id: r.id,
      robotId: r.robot_id,
      threadKey: r.thread_key,
      chatId: r.chat_id,
      senderId: r.sender_id,
      sessionId: r.session_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      outcome: r.outcome as ImTurnOutcome | null,
      rejectReason: (r.reject_reason as ImInputRejectReason | null) ?? null,
      outboundChars: r.outbound_chars,
      error: r.error,
    }))
}
