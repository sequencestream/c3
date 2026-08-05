/**
 * Contract guards for the Git / forge failure guidance carried on `UiError`.
 *
 * Same shape of proof as the action-descriptor guards: the "must be rejected"
 * cases are pinned with `@ts-expect-error` (the assertion is that `tsc` fails the
 * line, and the annotation itself errors once the code becomes legal), and the
 * runtime assertions pin what a type cannot express — that both unions stay
 * closed and reach the public barrel, and that the guidance stays OPTIONAL on the
 * error payload so an older client is unaffected.
 */
import { describe, it, expect } from 'vitest'
import { GIT_ACTION_FAILURE_REASONS, INTENT_RETRY_ACTIONS } from '../protocol.js'
import type {
  GitActionFailureGuidance,
  GitActionFailureReason,
  IntentActionRetryTarget,
  IntentRetryAction,
} from '../protocol.js'
import type { UiError } from '../ui-codes.js'

describe('GitActionFailureGuidance', () => {
  it('exports the closed reason list through the public barrel', () => {
    expect(GIT_ACTION_FAILURE_REASONS).toEqual([
      'worktree_branch_or_path_taken',
      'repo_conflict_unresolved',
      'filesystem_denied',
      'forge_cli_unavailable',
      'remote_permission_denied',
      'push_rejected',
      'network_unreachable',
      'commit_hook_rejected',
      'forge_create_rejected',
      'unknown',
    ])
    // The runtime list and the type must stay the same set in both directions.
    const reasons: readonly GitActionFailureReason[] = GIT_ACTION_FAILURE_REASONS
    expect(new Set(reasons).size).toBe(GIT_ACTION_FAILURE_REASONS.length)
  })

  it('exports the closed retry-action list through the public barrel', () => {
    expect(INTENT_RETRY_ACTIONS).toEqual(['start-development', 'create-pr'])
    const actions: readonly IntentRetryAction[] = INTENT_RETRY_ACTIONS
    expect(new Set(actions).size).toBe(INTENT_RETRY_ACTIONS.length)
  })

  it('accepts a well-formed guidance with a retry target', () => {
    const guidance: GitActionFailureGuidance = {
      reason: 'worktree_branch_or_path_taken',
      detail: "fatal: a branch named 'intent-1' already exists",
      retry: { type: 'intent-action', intentId: 'intent-1', action: 'start-development' },
    }
    expect(guidance.retry.action).toBe('start-development')
  })

  it('keeps the raw detail on an unknown reason too', () => {
    const guidance: GitActionFailureGuidance = {
      reason: 'unknown',
      detail: 'fatal: something nobody classified\nsecond line',
      retry: { type: 'intent-action', intentId: 'intent-1', action: 'create-pr' },
    }
    expect(guidance.detail).toContain('\n')
  })

  it('stays optional on the error payload so an older client is unaffected', () => {
    const withoutGuidance: UiError = { code: 'intent.worktreeCreateFailed' }
    const withGuidance: UiError = {
      code: 'intent.worktreeCreateFailed',
      params: { message: 'boom' },
      guidance: {
        reason: 'filesystem_denied',
        detail: 'boom',
        retry: { type: 'intent-action', intentId: 'i-1', action: 'start-development' },
      },
    }
    expect(withoutGuidance.guidance).toBeUndefined()
    expect(withGuidance.guidance?.reason).toBe('filesystem_denied')
  })

  it('rejects an unknown reason code', () => {
    // @ts-expect-error reasons are closed so the client can localize them all;
    // a new category must be added to the union, not smuggled in as free text.
    const reason: GitActionFailureReason = 'worktree_exploded'
    expect(reason).toBeTruthy()
  })

  it('rejects an unknown retry action', () => {
    const target: IntentActionRetryTarget = {
      type: 'intent-action',
      intentId: 'i-1',
      // @ts-expect-error the retry surface is exactly the two intent entry points.
      action: 'delete-worktree',
    }
    expect(target).toBeTruthy()
  })

  it('rejects a retry target missing the intent', () => {
    // @ts-expect-error intentId is what binds the retry to one intent; without it
    // the button would have no subject.
    const target: IntentActionRetryTarget = { type: 'intent-action', action: 'create-pr' }
    expect(target).toBeTruthy()
  })

  it('rejects a retry target of another type', () => {
    // @ts-expect-error a retry re-invokes an intent entry point — it is not a
    // navigation target and never becomes one.
    const target: IntentActionRetryTarget = { type: 'intent-spec', intentId: 'i-1' }
    expect(target).toBeTruthy()
  })

  it('rejects free-text / command payload on a retry target', () => {
    const target: IntentActionRetryTarget = {
      type: 'intent-action',
      intentId: 'i-1',
      action: 'create-pr',
      // @ts-expect-error a retry target carries the intent and the enumerated
      // action only — never a command, a URL, or an arbitrary callback.
      command: 'git worktree remove --force',
    }
    expect(target).toBeTruthy()
  })

  it('rejects a guidance without its raw detail', () => {
    // @ts-expect-error detail is required — the raw error is kept for known and
    // unknown reasons alike, so a user always has something to debug with.
    const guidance: GitActionFailureGuidance = {
      reason: 'push_rejected',
      retry: { type: 'intent-action', intentId: 'i-1', action: 'create-pr' },
    }
    expect(guidance).toBeTruthy()
  })
})
