import { describe, expect, it } from 'vitest'
import type { Intent, SessionInfo } from '@ccc/shared/protocol'
import {
  beginPendingWorkSessionSelect,
  resolveJumpTargetSessionId,
  resolvePendingWorkSessionSelect,
  shouldJumpAfterDevLaunch,
  WORK_SESSION_JUMP_DELAY_MS,
} from './work-session-jump'

function intent(id: string, lastWorkSessionId: string | null): Intent {
  return { id, lastWorkSessionId } as Intent
}

function session(id: string): SessionInfo {
  return {
    sessionId: id,
    title: id,
    lastModified: 1,
    mode: 'default',
    isToolSession: false,
    vendor: 'claude',
  }
}

describe('shouldJumpAfterDevLaunch — only the success terminal jumps', () => {
  it('jumps on `ready`', () => {
    expect(shouldJumpAfterDevLaunch('ready')).toBe(true)
  })
  it('does not jump on `failed` / `timeout`', () => {
    expect(shouldJumpAfterDevLaunch('failed')).toBe(false)
    expect(shouldJumpAfterDevLaunch('timeout')).toBe(false)
  })
  it('does not jump when the overlay merely advanced (no close reason)', () => {
    expect(shouldJumpAfterDevLaunch(undefined)).toBe(false)
  })
})

describe('resolveJumpTargetSessionId — reverse-lookup via lastWorkSessionId', () => {
  const list = [intent('a', 'dev-a'), intent('b', null)]
  it('returns the intent`s lastWorkSessionId when present', () => {
    expect(resolveJumpTargetSessionId('a', list)).toBe('dev-a')
  })
  it('returns null when the intent has no work session yet', () => {
    expect(resolveJumpTargetSessionId('b', list)).toBeNull()
  })
  it('returns null when the intent is absent from the list', () => {
    expect(resolveJumpTargetSessionId('missing', list)).toBeNull()
    expect(resolveJumpTargetSessionId('a', [])).toBeNull()
  })
})

describe('resolvePendingWorkSessionSelect — one-shot select once the target lands', () => {
  const sessions = [session('s1'), session('s2')]
  const baseRequest = beginPendingWorkSessionSelect('/ws', 'intent-1')

  it('keeps waiting when lastWorkSessionId is not available yet', () => {
    expect(
      resolvePendingWorkSessionSelect(baseRequest, {
        workspacePath: '/ws',
        sessionKind: 'work',
        intents: [intent('intent-1', null)],
        sessions,
      }),
    ).toEqual({ request: baseRequest, selectSessionId: null })
  })

  it('resolves the target id from a later intent projection and waits for the row', () => {
    expect(
      resolvePendingWorkSessionSelect(baseRequest, {
        workspacePath: '/ws',
        sessionKind: 'work',
        intents: [intent('intent-1', 's3')],
        sessions,
      }),
    ).toEqual({
      request: { workspacePath: '/ws', intentId: 'intent-1', sessionId: 's3' },
      selectSessionId: null,
    })
  })

  it('returns the requested id once it is in the list', () => {
    expect(
      resolvePendingWorkSessionSelect(
        { workspacePath: '/ws', intentId: 'intent-1', sessionId: 's2' },
        {
          workspacePath: '/ws',
          sessionKind: 'work',
          intents: [intent('intent-1', 's2')],
          sessions,
        },
      ),
    ).toEqual({ request: null, selectSessionId: 's2' })
  })
  it('returns null while the target has not yet landed (keep waiting)', () => {
    expect(
      resolvePendingWorkSessionSelect(
        { workspacePath: '/ws', intentId: 'intent-1', sessionId: 's3' },
        {
          workspacePath: '/ws',
          sessionKind: 'work',
          intents: [intent('intent-1', 's3')],
          sessions,
        },
      ),
    ).toEqual({
      request: { workspacePath: '/ws', intentId: 'intent-1', sessionId: 's3' },
      selectSessionId: null,
    })
  })
  it('returns null when no request is staged', () => {
    expect(
      resolvePendingWorkSessionSelect(null, {
        workspacePath: '/ws',
        sessionKind: 'work',
        intents: [intent('intent-1', 's2')],
        sessions,
      }),
    ).toEqual({ request: null, selectSessionId: null })
  })
  it('does not consume requests for another workspace or a non-work kind', () => {
    const request = { workspacePath: '/ws', intentId: 'intent-1', sessionId: 's2' }
    expect(
      resolvePendingWorkSessionSelect(request, {
        workspacePath: '/other',
        sessionKind: 'work',
        intents: [intent('intent-1', 's2')],
        sessions,
      }),
    ).toEqual({ request, selectSessionId: null })
    expect(
      resolvePendingWorkSessionSelect(request, {
        workspacePath: '/ws',
        sessionKind: 'spec',
        intents: [intent('intent-1', 's2')],
        sessions,
      }),
    ).toEqual({ request, selectSessionId: null })
  })
})

describe('WORK_SESSION_JUMP_DELAY_MS — deliberate ready buffer', () => {
  it('is ~1s', () => {
    expect(WORK_SESSION_JUMP_DELAY_MS).toBe(1000)
  })
})
