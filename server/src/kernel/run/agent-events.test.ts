/**
 * Unit tests for the agent-degradation bus event builders (2026-06-08).
 *
 * Two layers:
 *  1. Pure-builder payload shape — the builders the `launchRun` publish call sites
 *     wrap, so the payload contract is pinned here (not in the dependency-heavy
 *     launcher), mirroring the `decideResume` / `buildAgentsToTry` test split.
 *  2. Example subscriber — wire the builders through a real {@link EventBus} to
 *     prove the three topics are subscribable ("异常→切换之外的动作可挂接"), and
 *     that a throwing subscriber does NOT break sibling subscribers (the bus
 *     error-isolation guarantee the run loop relies on, ADR-0018).
 */
import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../events/event-bus.js'
import { agentErrorEvent, agentFallbackEvent, agentAllFailedEvent } from './agent-events.js'

describe('agent-events — pure payload builders', () => {
  it('agentErrorEvent carries agentId/agentName/error/degradable', () => {
    expect(
      agentErrorEvent({
        sessionId: 's1',
        workspacePath: '/w',
        agentId: 'sonnet',
        agentName: 'Sonnet',
        error: 'rate limited',
        degradable: true,
      }),
    ).toEqual({
      sessionId: 's1',
      workspacePath: '/w',
      agentId: 'sonnet',
      agentName: 'Sonnet',
      error: 'rate limited',
      degradable: true,
    })
  })

  it('agentFallbackEvent flattens from/to into the wire-style payload', () => {
    expect(
      agentFallbackEvent({
        sessionId: 's1',
        workspacePath: '/w',
        from: { agentId: 'sonnet', agentName: 'Sonnet' },
        to: { agentId: 'haiku', agentName: 'Haiku' },
      }),
    ).toEqual({
      sessionId: 's1',
      workspacePath: '/w',
      fromAgentId: 'sonnet',
      fromAgentName: 'Sonnet',
      toAgentId: 'haiku',
      toAgentName: 'Haiku',
    })
  })

  it('agentAllFailedEvent copies the failure list and omits empty crossVendorSkipped', () => {
    const payload = agentAllFailedEvent({
      sessionId: 's1',
      workspacePath: '/w',
      agents: [
        { agentId: 'sonnet', agentName: 'Sonnet', error: 'e1' },
        { agentId: 'haiku', agentName: 'Haiku', error: 'e2' },
      ],
      crossVendorSkipped: [],
    })
    expect(payload).toEqual({
      sessionId: 's1',
      workspacePath: '/w',
      agents: [
        { agentId: 'sonnet', agentName: 'Sonnet', error: 'e1' },
        { agentId: 'haiku', agentName: 'Haiku', error: 'e2' },
      ],
    })
    expect('crossVendorSkipped' in payload).toBe(false)
  })

  it('agentAllFailedEvent includes crossVendorSkipped when present', () => {
    const payload = agentAllFailedEvent({
      sessionId: 's1',
      workspacePath: '/w',
      agents: [{ agentId: 'sonnet', agentName: 'Sonnet', error: 'e1' }],
      crossVendorSkipped: [{ agentId: 'gpt', agentName: 'GPT', vendor: 'codex' }],
    })
    expect(payload.crossVendorSkipped).toEqual([
      { agentId: 'gpt', agentName: 'GPT', vendor: 'codex' },
    ])
  })
})

describe('agent-events — example subscriber over a real EventBus', () => {
  it('an external action can subscribe to all three degradation topics', () => {
    const bus = new EventBus()
    const onError = vi.fn()
    const onFallback = vi.fn()
    const onAllFailed = vi.fn()

    // Example: a feature wanting "异常→切换之外的动作" (audit / trigger a schedule)
    // subscribes at registration time — no change to the launcher needed.
    bus.subscribe('agent:error', onError)
    bus.subscribe('agent:fallback', onFallback)
    bus.subscribe('agent:all_failed', onAllFailed)

    bus.publish(
      'agent:error',
      agentErrorEvent({
        sessionId: 's1',
        workspacePath: '/w',
        agentId: 'sonnet',
        agentName: 'Sonnet',
        error: 'boom',
        degradable: true,
      }),
    )
    bus.publish(
      'agent:fallback',
      agentFallbackEvent({
        sessionId: 's1',
        workspacePath: '/w',
        from: { agentId: 'sonnet', agentName: 'Sonnet' },
        to: { agentId: 'haiku', agentName: 'Haiku' },
      }),
    )
    bus.publish(
      'agent:all_failed',
      agentAllFailedEvent({
        sessionId: 's1',
        workspacePath: '/w',
        agents: [{ agentId: 'sonnet', agentName: 'Sonnet', error: 'boom' }],
      }),
    )

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'sonnet', degradable: true }),
    )
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ fromAgentId: 'sonnet', toAgentId: 'haiku' }),
    )
    expect(onAllFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [{ agentId: 'sonnet', agentName: 'Sonnet', error: 'boom' }],
      }),
    )
  })

  it('a throwing subscriber does not break sibling subscribers (run-loop isolation)', () => {
    const bus = new EventBus()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = vi.fn(() => {
      throw new Error('subscriber blew up')
    })
    const sibling = vi.fn()

    bus.subscribe('agent:error', throwing)
    bus.subscribe('agent:error', sibling)

    // publish must NOT throw, and the sibling must still run.
    expect(() =>
      bus.publish(
        'agent:error',
        agentErrorEvent({
          sessionId: 's1',
          workspacePath: '/w',
          agentId: 'sonnet',
          agentName: 'Sonnet',
          error: 'boom',
          degradable: true,
        }),
      ),
    ).not.toThrow()
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(sibling).toHaveBeenCalledTimes(1)

    errorSpy.mockRestore()
  })
})
