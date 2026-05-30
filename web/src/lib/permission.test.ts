import { describe, it, expect } from 'vitest'
import { actionablePermissionId } from './permission'
import type { ChatMsg } from './chat-types'

// Build a permission ChatMsg with just the fields the function reads.
function perm(id: number, requestId: string, decision: 'allow' | 'deny' | null): ChatMsg {
  return { id, kind: 'permission', requestId, toolName: 'Bash', input: {}, decision }
}
function text(id: number): ChatMsg {
  return { id, kind: 'assistant', text: 'hi' }
}

describe('actionablePermissionId', () => {
  it('returns null when the session is not awaiting a decision', () => {
    // Replayed history: the permission is undecided in memory, but the session
    // has moved on — it must NOT be actionable (renders as a static record).
    const msgs = [perm(1, 'r1', null)]
    expect(actionablePermissionId(msgs, false)).toBeNull()
  })

  it('returns the last undecided permission while awaiting', () => {
    // The live pending request is the latest undecided permission.
    const msgs = [text(1), perm(2, 'r2', null)]
    expect(actionablePermissionId(msgs, true)).toBe('r2')
  })

  it('returns null when the latest permission was already decided', () => {
    // Answered live this session: not actionable (shows its decided verdict).
    const msgs = [perm(1, 'r1', 'allow')]
    expect(actionablePermissionId(msgs, true)).toBeNull()
  })

  it('only ever considers the latest permission, ignoring earlier ones', () => {
    // Earlier undecided permissions are superseded history; only the last
    // permission can be the live one the SDK is blocked on.
    const msgs = [perm(1, 'r1', null), text(2), perm(3, 'r3', null)]
    expect(actionablePermissionId(msgs, true)).toBe('r3')
  })

  it('returns null for a transcript with no permissions', () => {
    expect(actionablePermissionId([text(1)], true)).toBeNull()
  })

  it('an earlier undecided permission is not actionable once a later one exists', () => {
    // After the next request arrives, the previous one is resolved/superseded —
    // it must downgrade to a static record even while awaiting.
    const msgs = [perm(1, 'r1', null), perm(2, 'r2', null)]
    const id = actionablePermissionId(msgs, true)
    expect(id).toBe('r2')
    expect(id).not.toBe('r1')
  })
})
