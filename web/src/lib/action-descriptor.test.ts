/**
 * Unit tests for the client half of the derived next-step contract: which intent
 * a descriptor names, and what copy a label code renders. Pure functions, so they
 * test exactly the client-side resolution the banner does — a predecessor's
 * title and status come from the view's own intents, never from the wire.
 */
import { describe, expect, it } from 'vitest'
import type { ActionDescriptor } from '@ccc/shared/protocol'
import { applyLocale, t } from '@/i18n'
import { actionMessage, actionTargetIntent, type ActionTargetIntent } from './action-descriptor'

const DEP: ActionDescriptor = {
  labelCode: 'dependency_blocked',
  target: { type: 'intent-detail', intentId: 'i2' },
}

describe('actionTargetIntent', () => {
  it('resolves the named intent from the current view', () => {
    const byId = new Map<string, ActionTargetIntent>([
      ['i2', { title: '打底能力', status: 'todo' }],
    ])
    expect(actionTargetIntent(DEP, byId)).toEqual({ title: '打底能力', status: 'todo' })
  })

  it('returns null when the descriptor names no intent', () => {
    const byId = new Map<string, ActionTargetIntent>()
    expect(
      actionTargetIntent(
        { labelCode: 'spec_awaiting_approval', target: { type: 'intent-spec', intentId: 'i2' } },
        byId,
      ),
    ).toBeNull()
  })

  it('returns null for a null descriptor', () => {
    expect(actionTargetIntent(null, new Map())).toBeNull()
  })

  it('returns null when the named intent is outside the current view', () => {
    expect(actionTargetIntent(DEP, new Map())).toBeNull()
  })
})

describe('actionMessage', () => {
  it('interpolates the predecessor title and hands the status over as an i18n key', () => {
    const { key, named, statusKey } = actionMessage('dependency_blocked', {
      title: '打底',
      status: 'todo',
    })
    expect(key).toBe('intent.blocked.dependencyBlocked')
    expect(named).toEqual({ title: '打底' })
    expect(statusKey).toBe('intent.filter.todo.label')
  })

  it('uses the not-on-mainline copy for a done predecessor, not the finish-up copy', () => {
    // A done predecessor blocks only because it has not reached the mainline yet
    // (worktree mode); the copy must say exactly that instead of asking to finish
    // something already finished.
    const { key, named, statusKey } = actionMessage('dependency_blocked', {
      title: '打底',
      status: 'done',
    })
    expect(key).toBe('intent.blocked.dependencyBlockedDone')
    expect(named).toEqual({ title: '打底' })
    expect(statusKey).toBe('intent.filter.done.label')
  })

  it('resolves the predecessor status through the current locale, never a fixed English label', () => {
    const msg = actionMessage('dependency_blocked', { title: '打底', status: 'todo' })
    expect(msg.statusKey).toBe('intent.filter.todo.label')
    if (!msg.statusKey) return
    // The key, not an English label, is what reaches a non-English interface.
    applyLocale('zh')
    try {
      expect(t(msg.statusKey)).toBe('待办')
    } finally {
      applyLocale('en')
    }
  })

  it('falls back to the unresolved copy when no target intent is in view — no bare id', () => {
    expect(actionMessage('dependency_blocked', null)).toEqual({
      key: 'intent.blocked.dependencyBlockedUnresolved',
    })
  })

  it('leaves non-dependency codes as a plain key', () => {
    expect(actionMessage('vendor_quota_exhausted')).toEqual({
      key: 'intent.blocked.vendorQuotaExhausted',
    })
  })
})
