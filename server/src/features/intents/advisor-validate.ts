/**
 * Advisor proposal validation — the FIRST half of the two-belt interface between
 * the deterministic queue kernel and an on-demand advisor agent.
 *
 * The agent never drives the queue. It PROPOSES one structured action from a
 * closed vocabulary; this pure function accepts or rejects it against the bound
 * scope plus a fact snapshot. A rejection is structured — a stable reason code,
 * a displayable detail, whether retrying could ever help, and the constraint
 * values that decided it — so the agent learns WHY an action is impossible
 * instead of blindly retrying it.
 *
 * This is belt one. Belt two lives in the tools themselves: every write tool
 * re-reads authoritative facts and re-checks the same gates immediately before
 * its side effect (see `advisor-tools.ts`). Passing here grants nothing — a
 * caller that skips this function entirely is still stopped there, and facts
 * that changed between the two checks are decided by the later one.
 *
 * Pure: no I/O, no clock, no store. The caller collects {@link AdvisorFacts} and
 * owns every side effect.
 */
import type { IntentStatus } from '@ccc/shared/protocol'
import { canTransition } from './store.js'
import { MAX_CONTINUATIONS } from './turn-guards.js'

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Every action an advisor may propose. Closed by construction: an action that is
 * not listed here cannot be proposed, and adding one is a deliberate act with a
 * matching gate below.
 *
 * `resume_work_session` is proposable but has NO advisor tool of its own — the
 * deterministic kernel dispatches it through `launchWorkSession`, which applies
 * the same concurrency and pending-question gates a second time. That is why its
 * constraints are validated here even though no `continue_work_session` tool
 * exists.
 */
export const ADVISOR_ACTIONS = [
  'read_session_transcript',
  'get_run_status',
  'list_sessions',
  'stop_run',
  'reset_intent_session',
  'reset_spec_session',
  'update_intent_status',
  'create_pr',
  'sync_intent_pr_status',
  'raise_user_todo',
  'resume_work_session',
] as const

export type AdvisorAction = (typeof ADVISOR_ACTIONS)[number]

/**
 * Actions that are deliberately NOT offered, listed by name so a proposal for
 * one is rejected with a reason that names the policy rather than reading as an
 * unknown-action typo. Approving a spec is a human checkpoint; marking an intent
 * `done` has exactly one automated exception (the queue's own judge → commit →
 * push path) and this is not it.
 *
 * Aliases are included: renaming the action does not make it available.
 */
const WITHHELD_ACTIONS = new Set([
  'approve_spec',
  'approveSpec',
  'spec_approve',
  'set_spec_approved',
  'mark_spec_approved',
  'complete_intent',
  'mark_intent_done',
])

/**
 * Actions whose side effect replaces context or reaches outside c3, so they go
 * through the existing write-approval queue before executing. `stop_run` and
 * `raise_user_todo` do not: stopping a run is reversible (the session and its
 * transcript survive) and raising a todo is exactly the act of handing the
 * decision back to a human.
 */
const CONFIRMED_ACTIONS = new Set<AdvisorAction>([
  'reset_intent_session',
  'reset_spec_session',
  'update_intent_status',
  'create_pr',
  'sync_intent_pr_status',
])

/** Whether an accepted action must clear the write-approval queue before it runs. */
export function advisorActionRequiresConfirmation(action: AdvisorAction): boolean {
  return CONFIRMED_ACTIONS.has(action)
}

/** Stable rejection reason codes. Never carries prompts, credentials or transcript text. */
export type AdvisorRejectReason =
  | 'action_unknown'
  | 'action_withheld'
  | 'workspace_override_forbidden'
  | 'intent_scope_mismatch'
  | 'session_scope_mismatch'
  | 'intent_not_found'
  | 'session_required'
  | 'status_required'
  | 'target_status_done_forbidden'
  | 'illegal_status_transition'
  | 'concurrency_gate'
  | 'pending_question_unanswered'
  | 'continue_budget_exhausted'
  | 'chain_depth_exceeded'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The scope the advisor is bound to. Supplied by the closure that built the
 * tools, NEVER by the model: a proposal cannot widen it.
 */
export interface AdvisorScope {
  workspacePath: string
  intentId: string
  /**
   * How many advisor hops led here. 0 is a human- or kernel-originated first
   * consultation; each advisor-triggered consultation adds one.
   */
  chainDepth: number
}

/** The authoritative facts a validation pass reads. */
export interface AdvisorFacts {
  /** The bound intent, or `null` when it no longer exists. */
  intent: { id: string; status: IntentStatus } | null
  /** Session ids the bound intent owns (work / spec / intent-comm). */
  ownedSessionIds: readonly string[]
  /**
   * Titles of OTHER intents whose live work session would CONFLICT with this one
   * (RM-A12). The caller collects them, so it also owns the gate's scope: under
   * `current-branch` every live work session in the workspace belongs here,
   * while under `worktree` each intent has its own directory and none does — the
   * list is then empty and this validator rejects nothing on its account.
   */
  blockingIntentTitles: readonly string[]
  /** The bound intent's work session holds an unanswered `AskUserQuestion`. */
  pendingQuestion: boolean
  /** Continuations already spent on this intent. */
  continuations: number
  /** The continuation budget. Defaults to the queue's own cap. */
  maxContinuations?: number
}

/**
 * One proposed action. `workspacePath` is declared so an override ATTEMPT is
 * visible and rejectable — it is never read as a value.
 */
export interface AdvisorProposal {
  action: string
  intentId?: string
  sessionId?: string
  targetStatus?: IntentStatus
  workspacePath?: string
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type AdvisorValidation =
  | { accepted: true; action: AdvisorAction; requiresConfirmation: boolean }
  | {
      accepted: false
      reason: AdvisorRejectReason
      detail: string
      /**
       * Whether the SAME proposal could succeed later. `false` means the action
       * is impossible by policy — re-proposing it is always wasted work.
       */
      retryable: boolean
      /** The constraint values that decided it, so the agent can re-aim. */
      constraints?: Record<string, string>
    }

/** The maximum advisor chain depth. Beyond it no agent is started and no tool runs. */
export const ADVISOR_MAX_CHAIN_DEPTH = 3

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function reject(
  reason: AdvisorRejectReason,
  detail: string,
  retryable: boolean,
  constraints?: Record<string, string>,
): AdvisorValidation {
  return { accepted: false, reason, detail, retryable, ...(constraints ? { constraints } : {}) }
}

/** Actions that need a session id, and which must belong to the bound intent. */
const SESSION_SCOPED = new Set<AdvisorAction>([
  'read_session_transcript',
  'get_run_status',
  'stop_run',
])

/**
 * Validate one advisor proposal against the bound scope and a fact snapshot.
 * Gate order is fixed: chain depth → vocabulary → scope → per-action rules.
 * Depth comes first because exceeding it must stop the advisor before ANY
 * action is even considered.
 */
export function validateAdvisorProposal(
  scope: AdvisorScope,
  proposal: AdvisorProposal,
  facts: AdvisorFacts,
): AdvisorValidation {
  if (scope.chainDepth > ADVISOR_MAX_CHAIN_DEPTH) {
    return reject(
      'chain_depth_exceeded',
      `顾问调用链深度 ${scope.chainDepth} 超过上限 ${ADVISOR_MAX_CHAIN_DEPTH}`,
      false,
      { chainDepth: String(scope.chainDepth), maxChainDepth: String(ADVISOR_MAX_CHAIN_DEPTH) },
    )
  }

  // ── Vocabulary ──
  if (WITHHELD_ACTIONS.has(proposal.action)) {
    return reject(
      'action_withheld',
      `「${proposal.action}」不提供给自动化:规格审批与标记完成只属于人工检查点`,
      false,
    )
  }
  if (!(ADVISOR_ACTIONS as readonly string[]).includes(proposal.action)) {
    return reject('action_unknown', `未知动作「${proposal.action}」`, false, {
      allowed: ADVISOR_ACTIONS.join(','),
    })
  }
  const action = proposal.action as AdvisorAction

  // ── Scope ── the closure owns the workspace; a proposal may not restate it.
  if (proposal.workspacePath !== undefined) {
    return reject(
      'workspace_override_forbidden',
      '工具作用域由服务端闭包绑定,提案不得携带 workspacePath',
      false,
    )
  }
  if (proposal.intentId !== undefined && proposal.intentId !== scope.intentId) {
    return reject('intent_scope_mismatch', '提案的意图不是本次顾问绑定的意图', false, {
      boundIntentId: scope.intentId,
    })
  }
  if (!facts.intent) {
    return reject('intent_not_found', '绑定的意图已不存在', false, {
      boundIntentId: scope.intentId,
    })
  }

  if (SESSION_SCOPED.has(action)) {
    if (!proposal.sessionId) {
      return reject('session_required', `「${action}」必须指定 sessionId`, true)
    }
    if (!facts.ownedSessionIds.includes(proposal.sessionId)) {
      return reject('session_scope_mismatch', '该会话不属于本次顾问绑定的意图', false, {
        boundIntentId: scope.intentId,
      })
    }
  }

  // ── Per-action rules ──
  if (action === 'update_intent_status') {
    if (!proposal.targetStatus) {
      return reject('status_required', '状态更新必须指定 targetStatus', true)
    }
    // RM-R9's automated-completion exception belongs to the queue's own
    // judge → commit → push path and is not widened here.
    if (proposal.targetStatus === 'done') {
      return reject(
        'target_status_done_forbidden',
        '顾问不得把意图标记为 done——自动完成的唯一例外属于队列的评判+提交+推送路径',
        false,
        { targetStatus: 'done' },
      )
    }
    if (!canTransition(facts.intent.status, proposal.targetStatus)) {
      return reject(
        'illegal_status_transition',
        `不能从「${facts.intent.status}」转为「${proposal.targetStatus}」`,
        false,
        { from: facts.intent.status, to: proposal.targetStatus },
      )
    }
  }

  if (action === 'resume_work_session') {
    // RM-A12 — a conflicting concurrent work session is never opened, by anyone.
    // Which sessions conflict is decided by the caller's facts, not here.
    const blocking = facts.blockingIntentTitles[0]
    if (blocking !== undefined) {
      return reject('concurrency_gate', `工作区已有「${blocking}」的工作会话在运行`, true, {
        blockingIntent: blocking,
      })
    }
    // RM-A11 — a continuation prompt never stands in for a human's answer.
    if (facts.pendingQuestion) {
      return reject('pending_question_unanswered', '存在未作答的提问,必须由人作答', true)
    }
    const cap = facts.maxContinuations ?? MAX_CONTINUATIONS
    if (facts.continuations >= cap) {
      return reject(
        'continue_budget_exhausted',
        `续跑预算已耗尽(${facts.continuations}/${cap})`,
        false,
        {
          continuations: String(facts.continuations),
          maxContinuations: String(cap),
        },
      )
    }
  }

  return { accepted: true, action, requiresConfirmation: advisorActionRequiresConfirmation(action) }
}
