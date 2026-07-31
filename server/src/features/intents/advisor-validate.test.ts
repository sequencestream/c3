/**
 * Advisor proposal validator — belt one of the propose-then-validate pair.
 *
 * Every over-reach the design names is asserted to be REJECTED and to come back
 * with a structured reason the agent can act on: marking an intent `done`,
 * approving a spec (or any alias of it), bypassing the RM-A12 concurrency gate,
 * continuing over an unanswered question, outrunning the continuation budget,
 * reaching outside the bound intent/session, and overriding `workspacePath`.
 */
import { describe, expect, it } from 'vitest'
import {
  ADVISOR_ACTIONS,
  ADVISOR_MAX_CHAIN_DEPTH,
  advisorActionRequiresConfirmation,
  validateAdvisorProposal,
  type AdvisorFacts,
  type AdvisorProposal,
  type AdvisorScope,
  type AdvisorValidation,
} from './advisor-validate.js'
import { MAX_CONTINUATIONS } from './turn-guards.js'

const SCOPE: AdvisorScope = {
  workspacePath: '/ws',
  intentId: 'intent-1',
  chainDepth: 0,
}

function facts(over: Partial<AdvisorFacts> = {}): AdvisorFacts {
  return {
    intent: { id: 'intent-1', status: 'in_progress' },
    ownedSessionIds: ['sess-work'],
    blockingIntentTitles: [],
    pendingQuestion: false,
    continuations: 0,
    ...over,
  }
}

function run(
  proposal: AdvisorProposal,
  over: Partial<AdvisorFacts> = {},
  scope: AdvisorScope = SCOPE,
): AdvisorValidation {
  return validateAdvisorProposal(scope, proposal, facts(over))
}

/** Narrow a validation expected to be a rejection. */
function rejected(v: AdvisorValidation): Extract<AdvisorValidation, { accepted: false }> {
  expect(v.accepted).toBe(false)
  return v as Extract<AdvisorValidation, { accepted: false }>
}

describe('validateAdvisorProposal — withheld capabilities', () => {
  it('rejects marking the intent done, and says retrying can never help', () => {
    const r = rejected(run({ action: 'update_intent_status', targetStatus: 'done' }))
    expect(r.reason).toBe('target_status_done_forbidden')
    expect(r.retryable).toBe(false)
    expect(r.constraints?.targetStatus).toBe('done')
  })

  it.each(['approve_spec', 'approveSpec', 'spec_approve', 'mark_spec_approved'])(
    'rejects %s — the alias does not make it available',
    (action) => {
      const r = rejected(run({ action }))
      expect(r.reason).toBe('action_withheld')
      expect(r.retryable).toBe(false)
    },
  )

  it('rejects an action outside the closed vocabulary and lists what IS allowed', () => {
    const r = rejected(run({ action: 'rm_rf_workspace' }))
    expect(r.reason).toBe('action_unknown')
    expect(r.constraints?.allowed).toContain('stop_run')
  })

  it('never offers approve_spec in the vocabulary itself', () => {
    expect(ADVISOR_ACTIONS).not.toContain('approve_spec')
  })
})

describe('validateAdvisorProposal — scope binding', () => {
  it('rejects ANY workspacePath on the proposal, even the bound one', () => {
    const r = rejected(run({ action: 'list_sessions', workspacePath: '/ws' }))
    expect(r.reason).toBe('workspace_override_forbidden')
    expect(r.retryable).toBe(false)
  })

  it('rejects a proposal aimed at another intent', () => {
    const r = rejected(run({ action: 'sync_intent_pr_status', intentId: 'intent-2' }))
    expect(r.reason).toBe('intent_scope_mismatch')
    expect(r.constraints?.boundIntentId).toBe('intent-1')
  })

  it('rejects a session the bound intent does not own', () => {
    const r = rejected(run({ action: 'stop_run', sessionId: 'sess-someone-else' }))
    expect(r.reason).toBe('session_scope_mismatch')
    expect(r.retryable).toBe(false)
  })

  it('rejects a session-scoped action with no session id, and that IS retryable', () => {
    const r = rejected(run({ action: 'read_session_transcript' }))
    expect(r.reason).toBe('session_required')
    expect(r.retryable).toBe(true)
  })

  it('rejects everything once the bound intent is gone', () => {
    const r = rejected(run({ action: 'get_run_status', sessionId: 'sess-work' }, { intent: null }))
    expect(r.reason).toBe('intent_not_found')
  })
})

describe('validateAdvisorProposal — hard gates on a resume', () => {
  it('rejects a resume while another intent owns a running work session (RM-A12)', () => {
    const r = rejected(
      run({ action: 'resume_work_session' }, { blockingIntentTitles: ['其它意图'] }),
    )
    expect(r.reason).toBe('concurrency_gate')
    expect(r.retryable).toBe(true)
    expect(r.constraints?.blockingIntent).toBe('其它意图')
  })

  it('rejects a resume over an unanswered AskUserQuestion', () => {
    const r = rejected(run({ action: 'resume_work_session' }, { pendingQuestion: true }))
    expect(r.reason).toBe('pending_question_unanswered')
    expect(r.retryable).toBe(true)
  })

  it('rejects a resume once the continuation budget is spent', () => {
    const r = rejected(run({ action: 'resume_work_session' }, { continuations: MAX_CONTINUATIONS }))
    expect(r.reason).toBe('continue_budget_exhausted')
    expect(r.retryable).toBe(false)
    expect(r.constraints?.maxContinuations).toBe(String(MAX_CONTINUATIONS))
  })

  it('accepts a resume when no gate is shut', () => {
    expect(run({ action: 'resume_work_session' })).toEqual({
      accepted: true,
      action: 'resume_work_session',
      requiresConfirmation: false,
    })
  })
})

describe('validateAdvisorProposal — status transitions', () => {
  it('rejects an illegal transition with both endpoints in the constraints', () => {
    const r = rejected(
      run(
        { action: 'update_intent_status', targetStatus: 'in_progress' },
        {
          intent: { id: 'intent-1', status: 'done' },
        },
      ),
    )
    expect(r.reason).toBe('illegal_status_transition')
    expect(r.constraints).toEqual({ from: 'done', to: 'in_progress' })
  })

  it('accepts a legal non-done transition, and it needs confirmation', () => {
    expect(run({ action: 'update_intent_status', targetStatus: 'blocked' })).toEqual({
      accepted: true,
      action: 'update_intent_status',
      requiresConfirmation: true,
    })
  })

  it('requires a target status', () => {
    const r = rejected(run({ action: 'update_intent_status' }))
    expect(r.reason).toBe('status_required')
    expect(r.retryable).toBe(true)
  })
})

describe('validateAdvisorProposal — chain depth', () => {
  it('accepts at the limit', () => {
    const at = { ...SCOPE, chainDepth: ADVISOR_MAX_CHAIN_DEPTH }
    expect(run({ action: 'list_sessions' }, {}, at).accepted).toBe(true)
  })

  it('rejects past the limit BEFORE any action-specific rule is consulted', () => {
    const past = { ...SCOPE, chainDepth: ADVISOR_MAX_CHAIN_DEPTH + 1 }
    // An otherwise perfectly legal read is still refused.
    const r = rejected(run({ action: 'list_sessions' }, {}, past))
    expect(r.reason).toBe('chain_depth_exceeded')
    expect(r.retryable).toBe(false)
    expect(r.constraints?.maxChainDepth).toBe(String(ADVISOR_MAX_CHAIN_DEPTH))
  })
})

describe('advisorActionRequiresConfirmation — classification', () => {
  it('routes destructive and outward-facing actions through the approval queue', () => {
    for (const action of [
      'reset_intent_session',
      'reset_spec_session',
      'update_intent_status',
      'create_pr',
      'sync_intent_pr_status',
    ] as const) {
      expect(advisorActionRequiresConfirmation(action)).toBe(true)
    }
  })

  it('does not gate reads, stop_run, or handing the decision back to a human', () => {
    for (const action of [
      'read_session_transcript',
      'get_run_status',
      'list_sessions',
      'stop_run',
      'raise_user_todo',
    ] as const) {
      expect(advisorActionRequiresConfirmation(action)).toBe(false)
    }
  })
})
