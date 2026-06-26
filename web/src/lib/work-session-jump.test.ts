import { describe, expect, it } from 'vitest'
import type { Intent, SessionInfo } from '@ccc/shared/protocol'
import {
  resolveJumpTargetSessionId,
  resolvePendingWorkSessionSelect,
  shouldJumpAfterDevLaunch,
  WORK_SESSION_JUMP_DELAY_MS,
} from './work-session-jump'

function intent(id: string, lastDevSessionId: string | null): Intent {
  return { id, lastDevSessionId } as Intent
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

describe('resolveJumpTargetSessionId — reverse-lookup via lastDevSessionId', () => {
  const list = [intent('a', 'dev-a'), intent('b', null)]
  it('returns the intent`s lastDevSessionId when present', () => {
    expect(resolveJumpTargetSessionId('a', list)).toBe('dev-a')
  })
  it('returns null when the intent has no dev session yet', () => {
    expect(resolveJumpTargetSessionId('b', list)).toBeNull()
  })
  it('returns null when the intent is absent from the list', () => {
    expect(resolveJumpTargetSessionId('missing', list)).toBeNull()
    expect(resolveJumpTargetSessionId('a', [])).toBeNull()
  })
})

describe('resolvePendingWorkSessionSelect — one-shot select once the target lands', () => {
  const sessions = [session('s1'), session('s2')]
  it('returns the requested id once it is in the list', () => {
    expect(resolvePendingWorkSessionSelect('s2', sessions)).toBe('s2')
  })
  it('returns null while the target has not yet landed (keep waiting)', () => {
    expect(resolvePendingWorkSessionSelect('s3', sessions)).toBeNull()
  })
  it('returns null when no request is staged', () => {
    expect(resolvePendingWorkSessionSelect(null, sessions)).toBeNull()
  })
})

describe('WORK_SESSION_JUMP_DELAY_MS — deliberate ready buffer', () => {
  it('is ~1s', () => {
    expect(WORK_SESSION_JUMP_DELAY_MS).toBe(1000)
  })
})
