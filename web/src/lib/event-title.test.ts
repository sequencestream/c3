import { describe, expect, it } from 'vitest'
import { GIT_CLEANUP_EVENT_TOOL, type WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { eventDisplayTitle } from './event-title'
import { translateUiError } from '@/i18n/errors'

function ev(over: Partial<WaitUserInvolveEvent>): WaitUserInvolveEvent {
  return {
    id: 'e1',
    workspaceId: '/ws',
    sessionKind: 'intent',
    sessionId: 'I1',
    title: null,
    requestId: null,
    toolName: null,
    toolInput: null,
    status: 'todo',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('eventDisplayTitle', () => {
  it('localizes a git-cleanup failure todo via its UiError toolInput', () => {
    const uiErr = { code: 'intent.gitCleanupNoChanges' as const }
    const e = ev({ toolName: GIT_CLEANUP_EVENT_TOOL, toolInput: uiErr })
    // Routes through the UiError translator, not the raw sentinel toolName.
    expect(eventDisplayTitle(e, '🎯')).toBe(translateUiError(uiErr))
    expect(eventDisplayTitle(e, '🎯')).not.toBe(GIT_CLEANUP_EVENT_TOOL)
  })

  it('localizes a git-cleanup failure with detail params', () => {
    const uiErr = { code: 'intent.gitCleanupPrFailed' as const, params: { detail: 'boom' } }
    const e = ev({ toolName: GIT_CLEANUP_EVENT_TOOL, toolInput: uiErr })
    expect(eventDisplayTitle(e, '🎯')).toBe(translateUiError(uiErr))
  })

  it('prefers an explicit title for ordinary events', () => {
    expect(eventDisplayTitle(ev({ title: 'Permission needed', toolName: 'Bash' }), '🎯')).toBe(
      'Permission needed',
    )
  })

  it('falls back to toolName, then the provided fallback', () => {
    expect(eventDisplayTitle(ev({ toolName: 'AskUserQuestion' }), '🎯')).toBe('AskUserQuestion')
    expect(eventDisplayTitle(ev({}), '🎯')).toBe('🎯')
  })

  it('does not localize when the sentinel toolInput is not a UiError', () => {
    const e = ev({ toolName: GIT_CLEANUP_EVENT_TOOL, toolInput: { notCode: true } })
    expect(eventDisplayTitle(e, '🎯')).toBe(GIT_CLEANUP_EVENT_TOOL)
  })
})
