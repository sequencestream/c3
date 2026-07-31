/**
 * The advisor chain-depth gate — the entry constraint that keeps a consultation
 * from feeding itself.
 *
 * The queue already carries two self-excitation guards: a stable origin tag on
 * every kernel-started run, and a per-intent cooldown window. Both bound how
 * OFTEN work restarts. Neither bounds how DEEP a chain goes — an advisor whose
 * action leads to another consultation, which leads to another. This is that
 * third guard.
 *
 * It is checked BEFORE anything happens: no agent run is created, no tool
 * executes, no side effect lands. The refusal is recorded in `queue_decision_log`
 * with a stable reason code so "why did nothing happen?" has a displayable
 * answer instead of silence.
 *
 * A failed log write does NOT relax the limit. The audit trail is allowed to lose
 * a row; the gate is not allowed to open because it did.
 *
 * This module only says whether a consultation may START. It says nothing about
 * WHEN one should be triggered — that decision is not built yet.
 */
import { randomUUID } from 'node:crypto'
import { appendQueueDecisions } from './queue-store.js'
import { ADVISOR_MAX_CHAIN_DEPTH } from './advisor-validate.js'

export interface AdvisorChainCheckInput {
  workspacePath: string
  intentId: string
  /** Advisor hops that led here. 0 = a human- or kernel-originated first consultation. */
  chainDepth: number
  /** The origin tag of the run that would be started, carried through for audit. */
  origin: string
  /** Injected for tests. */
  now?: () => number
}

export type AdvisorChainCheck =
  { allowed: true } | { allowed: false; reason: 'blocked_chain_depth'; detail: string }

/**
 * Decide whether an advisor consultation may start. Over the limit, the refusal
 * is logged and returned; nothing else runs.
 */
export function checkAdvisorChainDepth(input: AdvisorChainCheckInput): AdvisorChainCheck {
  if (input.chainDepth <= ADVISOR_MAX_CHAIN_DEPTH) return { allowed: true }

  const detail = `顾问调用链深度 ${input.chainDepth} 超过上限 ${ADVISOR_MAX_CHAIN_DEPTH},本次不唤起顾问`
  // Best-effort audit. `appendQueueDecisions` already swallows and reports its
  // own failures; we ignore the boolean deliberately — see the module header.
  appendQueueDecisions([
    {
      tickId: `advisor-${randomUUID()}`,
      workspacePath: input.workspacePath,
      intentId: input.intentId,
      decidedAt: (input.now ?? Date.now)(),
      action: 'block',
      blockedGate: 'blocked_chain_depth',
      rejectReason: detail,
      attemptCount: input.chainDepth,
      backoffCount: 0,
      nextWakeupAt: null,
    },
  ])
  return { allowed: false, reason: 'blocked_chain_depth', detail }
}
