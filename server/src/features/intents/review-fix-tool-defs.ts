/**
 * Shared, framing-free definitions for the two intent PR review / fix sync MCP
 * tools, kept ONE source so every surface that exposes them never drifts. Today
 * only the unattended-automation c3 MCP tool set (`../automations/c3-tools.ts`)
 * registers them.
 *
 * These are the terminal backfill tools: they write ONLY a review / fix
 * conclusion and the session that produced it. They deliberately accept no
 * `pending`, no `null`, no round counter, no note and no arbitrary intent patch —
 * the transient `pending` state and the round counter are driven by the relay
 * orchestration that runs the review / fix turns, not by these tools. A
 * `reviewStatus: 'rejected'` implies a fix round is needed; a `fixStatus: 'fixed'`
 * records that a round was handled, and it does NOT auto-approve the review.
 *
 * The session id is caller-supplied and verbatim: it MUST be the c3 `c3SessionId`
 * of the session that produced the conclusion — never a vendor session id and
 * never the automation's own `executionId`. The workspace is server-derived, so a
 * caller cannot name one, which makes "workspace A cannot write workspace B's
 * status" structural.
 *
 * This module is framing-free: it owns the zod input shapes, the descriptions
 * advertised in the system prompt, and the CORE logic. The MCP framing — tool
 * registration + the per-run binding closure that supplies `workspacePath` and
 * the broadcast callback — lives in each surface.
 */
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Intent } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { getIntent, isStoreAvailable, updateIntentReviewFixStatus } from './store.js'

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface ReviewFixToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string): ReviewFixToolResult['content'] => [{ type: 'text' as const, text: s }]
const fail = (reason: string): ReviewFixToolResult => ({ content: text(reason), isError: true })

/** The only review conclusions a sync tool may write — terminals, not `pending`. */
const REVIEW_TERMINALS = ['approved', 'rejected'] as const
/** The only fix conclusion a sync tool may write — the single terminal. */
const FIX_TERMINALS = ['fixed'] as const

// ---- Zod input shapes (raw shapes; both `tool()` and `registerTool` accept them) ----

export const syncIntentReviewStatusSchema = {
  intentId: z.string().min(1).describe('要回填 PR 评审结论的本项目意图 id'),
  reviewSessionId: z
    .string()
    .min(1)
    .describe(
      '产生该评审结论的 c3 会话 c3SessionId(不是厂商 session id,也不是 automation executionId)',
    ),
  reviewStatus: z
    .enum(REVIEW_TERMINALS)
    .describe('评审终态:approved=通过, rejected=发现问题(需要修复)。不接受 pending。'),
}

export const syncIntentFixStatusSchema = {
  intentId: z.string().min(1).describe('要回填修复结论的本项目意图 id'),
  fixSessionId: z
    .string()
    .min(1)
    .describe(
      '产生该修复结论的 c3 会话 c3SessionId(不是厂商 session id,也不是 automation executionId)',
    ),
  fixStatus: z
    .enum(FIX_TERMINALS)
    .describe('修复终态:fixed=本轮已处理。不接受 pending;fixed 不代表评审通过。'),
}

export type SyncIntentReviewStatusArgs = {
  intentId: string
  reviewSessionId: string
  reviewStatus: 'approved' | 'rejected'
}

export type SyncIntentFixStatusArgs = {
  intentId: string
  fixSessionId: string
  fixStatus: 'fixed'
}

// ---- Description strings (advertised in the system prompt) ----

export const syncIntentReviewStatusDesc =
  '把本项目一条意图的 PR AI 评审结论回填为终态。' +
  '必填 intentId、reviewSessionId、reviewStatus;reviewStatus 仅接受 approved(通过)或 rejected(发现问题)。' +
  'reviewSessionId 必须是产生该结论的 c3 会话 c3SessionId,不要用厂商 session id 或 automation executionId 代替。' +
  '本工具只写评审终态与会话绑定:不写修复阶段、不增加复审轮次、不写 WorkNote、不接受 pending。' +
  '不存在或属于其他项目的 intentId、非法状态或数据库失败均返回错误;成功回显意图 id 与已保存字段。'

export const syncIntentFixStatusDesc =
  '把本项目一条意图的修复轮次结论回填为终态。' +
  '必填 intentId、fixSessionId、fixStatus;fixStatus 仅接受 fixed(本轮已处理)。' +
  'fixSessionId 必须是产生该结论的 c3 会话 c3SessionId,不要用厂商 session id 或 automation executionId 代替。' +
  '本工具只写修复终态与会话绑定:不写评审阶段、不增加复审轮次、不写 WorkNote、不接受 pending;fixed 不代表评审通过。' +
  '不存在或属于其他项目的 intentId、非法状态或数据库失败均返回错误;成功回显意图 id 与已保存字段。'

// ---- Core logic (framing-free; bound to ONE project via `workspacePath`) ----

/**
 * The project-scoped existence + ownership guard both tools share: the intent must
 * exist and its workspace identity must resolve to the bound workspace, so an id
 * from another project reads as "not found" and never leaks its records.
 */
function findOwnedIntent(workspacePath: string, intentId: string) {
  const req = getIntent(intentId)
  if (!req || resolveWorkspaceRoot(req.workspaceName) !== resolve(workspacePath)) return null
  return req
}

/**
 * Reject a backfill that no longer belongs to the phase it names.
 *
 * A conclusion is only accepted from the session that CURRENTLY holds the phase.
 * The check is scoped to the queue-driven relay — an intent whose phase field
 * still holds a session id the queue put there — so the manual / non-queue entry
 * points keep their existing shape and an intent nobody is driving still accepts
 * a plain human backfill.
 *
 * Repeating the SAME terminal from the holding session is idempotent and allowed;
 * what is refused is an EXPIRED session writing over a phase that has since moved
 * on — the round-two review concluding after round three already started.
 * Returns the refusal text, or `null` when the write may proceed.
 */
function staleRelayBackfill(
  intent: Intent,
  phase: 'review' | 'fix',
  callerSessionId: string,
): string | null {
  const holder = phase === 'review' ? intent.reviewSessionId : intent.fixSessionId
  // Nobody holds this phase (never started, already released, or a purely manual
  // intent): the existing unguarded behaviour stands.
  if (!holder) return null
  if (holder === callerSessionId) return null
  return (
    `会话 ${callerSessionId} 不再持有该意图的${phase === 'review' ? '评审' : '修复'}阶段` +
    `(当前为 ${holder}),已过期的结论不会覆盖新阶段。`
  )
}

/**
 * Write a review terminal + session for one project intent and echo the stored
 * fields as JSON. `onBroadcast` refreshes the intent list to every connection
 * after a change. The terminal-only enum is re-validated HERE (not just at the
 * transport's zod gate) so a `pending` value can never slip through to the store
 * even when the zod layer is bypassed; the store additionally rejects any value
 * outside the full `INTENT_REVIEW_STATUSES` closed set.
 */
export function runSyncIntentReviewStatus(
  workspacePath: string,
  args: SyncIntentReviewStatusArgs,
  onBroadcast?: (workspacePath: string) => void,
): ReviewFixToolResult {
  if (!isStoreAvailable()) return fail('意图库不可用,无法回填评审状态。')
  if (!(REVIEW_TERMINALS as readonly string[]).includes(args.reviewStatus)) {
    return fail(`非法评审状态 ${args.reviewStatus}:仅接受 approved 或 rejected。`)
  }
  const owned = findOwnedIntent(workspacePath, args.intentId)
  if (!owned) {
    return fail(`未找到 id 为 ${args.intentId} 的意图(本项目)。`)
  }
  const stale = staleRelayBackfill(owned, 'review', args.reviewSessionId)
  if (stale) return fail(stale)
  try {
    const updated = updateIntentReviewFixStatus(args.intentId, {
      reviewSessionId: args.reviewSessionId,
      reviewStatus: args.reviewStatus,
    })
    onBroadcast?.(workspacePath)
    return {
      content: text(
        JSON.stringify({
          intentId: updated.id,
          reviewSessionId: updated.reviewSessionId,
          reviewStatus: updated.reviewStatus,
        }),
      ),
    }
  } catch (err) {
    return fail(`回填评审状态失败:${String(err)}`)
  }
}

/**
 * Write a fix terminal + session for one project intent and echo the stored
 * fields as JSON. Mirrors {@link runSyncIntentReviewStatus}: terminal-only enum
 * re-validated at the core, project-scoped ownership guard, atomic store write
 * that never touches the review phase or the round counter.
 */
export function runSyncIntentFixStatus(
  workspacePath: string,
  args: SyncIntentFixStatusArgs,
  onBroadcast?: (workspacePath: string) => void,
): ReviewFixToolResult {
  if (!isStoreAvailable()) return fail('意图库不可用,无法回填修复状态。')
  if (!(FIX_TERMINALS as readonly string[]).includes(args.fixStatus)) {
    return fail(`非法修复状态 ${args.fixStatus}:仅接受 fixed。`)
  }
  const owned = findOwnedIntent(workspacePath, args.intentId)
  if (!owned) {
    return fail(`未找到 id 为 ${args.intentId} 的意图(本项目)。`)
  }
  const stale = staleRelayBackfill(owned, 'fix', args.fixSessionId)
  if (stale) return fail(stale)
  try {
    const updated = updateIntentReviewFixStatus(args.intentId, {
      fixSessionId: args.fixSessionId,
      fixStatus: args.fixStatus,
    })
    onBroadcast?.(workspacePath)
    return {
      content: text(
        JSON.stringify({
          intentId: updated.id,
          fixSessionId: updated.fixSessionId,
          fixStatus: updated.fixStatus,
        }),
      ),
    }
  } catch (err) {
    return fail(`回填修复状态失败:${String(err)}`)
  }
}
