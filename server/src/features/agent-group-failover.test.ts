import { describe, expect, it, vi, beforeEach } from 'vitest'

const advanceGroupCursor = vi.fn<(sessionId: string) => string | null>()
vi.mock('../kernel/agent-config/index.js', () => ({
  advanceGroupCursor: (sessionId: string) => advanceGroupCursor(sessionId),
}))

import { handleAgentGroupFailure, registerAgentGroupFailover } from './agent-group-failover.js'

beforeEach(() => {
  advanceGroupCursor.mockReset()
  advanceGroupCursor.mockReturnValue('next-member')
})

describe('agent group failover on a run failure (ADR-0029)', () => {
  it('a degradable failure moves the session onto the next candidate', () => {
    expect(handleAgentGroupFailure({ sessionId: 's1', degradable: true })).toEqual({
      advanced: true,
      nextAgentId: 'next-member',
    })
    expect(advanceGroupCursor).toHaveBeenCalledWith('s1')
  })

  it('a non-degradable failure is left alone — no sibling can fix it', () => {
    expect(handleAgentGroupFailure({ sessionId: 's1', degradable: false })).toEqual({
      advanced: false,
      nextAgentId: null,
    })
    expect(advanceGroupCursor).not.toHaveBeenCalled()
  })

  it('a session that is not bound to a group reports no advance', () => {
    advanceGroupCursor.mockReturnValue(null)
    expect(handleAgentGroupFailure({ sessionId: 's1', degradable: true })).toEqual({
      advanced: false,
      nextAgentId: null,
    })
  })

  it('subscribes to agent:error and forwards the event’s degradable verdict', () => {
    const handlers: Record<string, (e: unknown) => void> = {}
    const eventBus = {
      subscribe: (topic: string, cb: (e: unknown) => void) => {
        handlers[topic] = cb
      },
    }
    registerAgentGroupFailover({
      eventBus: eventBus as unknown as Parameters<typeof registerAgentGroupFailover>[0]['eventBus'],
    })
    handlers['agent:error']({ sessionId: 's9', degradable: true })
    expect(advanceGroupCursor).toHaveBeenCalledWith('s9')
  })
})
