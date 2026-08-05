/**
 * The client half of the failure-guidance contract: the copy maps stay total, and
 * the validator refuses anything the closed protocol unions do not name.
 *
 * The validator is the security-relevant half — a guidance that survives it gets
 * a button the user can press, so a malformed or unknown payload must produce
 * `null` rather than a best-effort object.
 */
import { describe, expect, it } from 'vitest'
import { GIT_ACTION_FAILURE_REASONS, INTENT_RETRY_ACTIONS } from '@ccc/shared/protocol'
import type { GitActionFailureGuidance } from '@ccc/shared/protocol'
import {
  GUIDANCE_MESSAGE_KEYS,
  RETRY_BUTTON_KEYS,
  guidanceMessageKey,
  normalizeGuidance,
  retryButtonKey,
} from './git-failure-guidance'
import en from '@/locales/en.json'

/** Resolve a dotted locale key against the base catalog. */
function leaf(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (!node || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[part]
  }, en)
}

const VALID: GitActionFailureGuidance = {
  reason: 'push_rejected',
  detail: 'git push 失败: ! [rejected]',
  retry: { type: 'intent-action', intentId: 'i-1', action: 'create-pr' },
}

describe('guidance copy maps', () => {
  it('has an instruction for every reason except unknown', () => {
    for (const reason of GIT_ACTION_FAILURE_REASONS) {
      if (reason === 'unknown') {
        // No cause identified ⇒ no defensible steps; the raw error stands alone.
        expect(guidanceMessageKey(reason)).toBeNull()
        continue
      }
      const key = guidanceMessageKey(reason)
      expect(key).toBe(GUIDANCE_MESSAGE_KEYS[reason])
      expect(typeof leaf(key!)).toBe('string')
    }
  })

  it('has a button label for every retry action', () => {
    for (const action of INTENT_RETRY_ACTIONS) {
      const key = retryButtonKey(action)
      expect(key).toBe(RETRY_BUTTON_KEYS[action])
      expect(typeof leaf(key)).toBe('string')
    }
  })

  it('has the raw-detail label and the no-detail fallback', () => {
    expect(typeof leaf('intent.gitFailure.rawDetail.label')).toBe('string')
    expect(typeof leaf('intent.gitFailure.noDetail')).toBe('string')
  })
})

describe('normalizeGuidance', () => {
  it('accepts a well-formed payload unchanged', () => {
    expect(normalizeGuidance(VALID)).toEqual(VALID)
  })

  it('accepts every reason in the closed union', () => {
    for (const reason of GIT_ACTION_FAILURE_REASONS) {
      expect(normalizeGuidance({ ...VALID, reason })?.reason).toBe(reason)
    }
  })

  it('normalizes a missing detail to empty rather than dropping the guidance', () => {
    // Absent detail is a display case (the dialog shows its stable fallback), not
    // a reason to throw away a valid reason + retry.
    const { detail: _detail, ...withoutDetail } = VALID
    expect(normalizeGuidance(withoutDetail)).toEqual({ ...VALID, detail: '' })
  })

  it('rejects a reason outside the union', () => {
    expect(normalizeGuidance({ ...VALID, reason: 'worktree_exploded' })).toBeNull()
  })

  it('rejects a retry action outside the union', () => {
    expect(
      normalizeGuidance({ ...VALID, retry: { ...VALID.retry, action: 'delete-worktree' } }),
    ).toBeNull()
  })

  it('rejects a retry target of another type', () => {
    expect(
      normalizeGuidance({ ...VALID, retry: { type: 'intent-spec', intentId: 'i-1' } }),
    ).toBeNull()
  })

  it('rejects a retry with a missing or blank intent', () => {
    expect(normalizeGuidance({ ...VALID, retry: { ...VALID.retry, intentId: '' } })).toBeNull()
    expect(
      normalizeGuidance({ ...VALID, retry: { type: 'intent-action', action: 'create-pr' } }),
    ).toBeNull()
  })

  it('rejects a non-object, a null and an absent payload', () => {
    expect(normalizeGuidance(undefined)).toBeNull()
    expect(normalizeGuidance(null)).toBeNull()
    expect(normalizeGuidance('push_rejected')).toBeNull()
    expect(normalizeGuidance(42)).toBeNull()
  })

  it('drops any extra payload the wire type does not name', () => {
    const normalized = normalizeGuidance({
      ...VALID,
      command: 'rm -rf /',
      retry: { ...VALID.retry, url: 'https://evil.example' },
    })
    expect(normalized).toEqual(VALID)
    expect(normalized && 'command' in normalized).toBe(false)
    expect(normalized && 'url' in normalized.retry).toBe(false)
  })
})
