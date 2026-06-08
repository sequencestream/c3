/**
 * Tests for resident domain subscriptions — discussion and schedule lifecycle
 * events that arrived in 2026-06-08-010 (discussion / schedule run bus).
 *
 * Three subscriptions to cover:
 *  1. `run:settled` + kind=discussion → broadcastDiscussions
 *  2. `run:settled` + kind=schedule   → broadcastSchedules
 *  3. Cross-kind isolation (session/discussion/schedule don't leak into each
 *     other's handlers, and the existing subscription handlers are untouched)
 *
 * The existing session/intent subscriptions are tested by their own
 * integration tests; here we only cover the two new subscriptions and the
 * cross-kind guard (Acceptance criterion 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../kernel/events/event-bus.js'
import type { DomainSubDeps } from './run-domain-subscriptions.js'

// ---------------------------------------------------------------------------
// Mock the feature modules that registerRunDomainSubscriptions depends on
// (we only test the subscription dispatch, not the real state).
// ---------------------------------------------------------------------------
vi.mock('../runs.js', () => ({ getRuntime: vi.fn(() => undefined) }))
vi.mock('../state.js', () => ({ setSessionMode: vi.fn() }))
vi.mock('../features/intents/store.js', () => ({
  getIntent: vi.fn(),
  rebindChatSession: vi.fn(),
  setLastDevSession: vi.fn(),
  updateStatus: vi.fn(),
  listIntents: vi.fn(() => []),
}))
vi.mock('../features/intents/dev-link.js', () => ({ takePendingDevLink: vi.fn(() => null) }))
vi.mock('../features/intents/automation.js', () => ({ notifyTurnSettled: vi.fn() }))

// Dynamic import so all vi.mocks are in place first.
const { registerRunDomainSubscriptions } = await import('./run-domain-subscriptions.js')

describe('resident domain subscriptions — discussion + schedule', () => {
  let eb: EventBus
  const mockBroadcastDiscussions = vi.fn()
  const mockBroadcastSchedules = vi.fn()
  const mockBroadcastSessions = vi.fn()
  const mockBroadcastIntents = vi.fn()
  const mockBroadcastIntentSessions = vi.fn()

  function install(): void {
    const deps: DomainSubDeps = {
      eventBus: eb,
      broadcaster: {
        toAll: vi.fn(),
      } as unknown as import('../transport/broadcaster.js').Broadcaster,
      broadcastSessions: mockBroadcastSessions,
      broadcastIntents: mockBroadcastIntents,
      broadcastIntentSessions: mockBroadcastIntentSessions,
      broadcastDiscussions: mockBroadcastDiscussions,
      broadcastSchedules: mockBroadcastSchedules,
    }
    registerRunDomainSubscriptions(deps)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    eb = new EventBus()
  })

  afterEach(() => {
    eb.clear()
  })

  // ── Discussion subscription ──────────────────────────────────────────

  it('discussion sub: run:settled with kind=discussion fires broadcastDiscussions', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'disc-1',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'discussion',
    })
    expect(mockBroadcastDiscussions).toHaveBeenCalledWith('/proj')
    expect(mockBroadcastDiscussions).toHaveBeenCalledTimes(1)
    expect(mockBroadcastSchedules).not.toHaveBeenCalled()
  })

  it('discussion sub: run:settled with kind=session does NOT fire broadcastDiscussions', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sess-1',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'session',
    })
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  it('discussion sub: run:settled with kind=schedule does NOT fire broadcastDiscussions', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sch-1',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'schedule',
    })
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  // ── Schedule subscription ────────────────────────────────────────────

  it('schedule sub: run:settled with kind=schedule fires broadcastSchedules', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'log-1',
      workspacePath: '/ws-a',
      reason: 'complete',
      kind: 'schedule',
    })
    expect(mockBroadcastSchedules).toHaveBeenCalledWith('/ws-a')
    expect(mockBroadcastSchedules).toHaveBeenCalledTimes(1)
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  it('schedule sub: run:settled with kind=session does NOT fire broadcastSchedules', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sess-1',
      workspacePath: '/ws-a',
      reason: 'error',
      kind: 'session',
    })
    expect(mockBroadcastSchedules).not.toHaveBeenCalled()
  })

  it('schedule sub: run:settled with kind=discussion does NOT fire broadcastSchedules', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'disc-1',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'discussion',
    })
    expect(mockBroadcastSchedules).not.toHaveBeenCalled()
  })

  // ── Cross-kind isolation ─────────────────────────────────────────────

  it('run:settled kind=session fires ONLY the existing broadcastSessions', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sess-x',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'session',
    })
    expect(mockBroadcastSessions).toHaveBeenCalledWith('/proj')
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
    expect(mockBroadcastSchedules).not.toHaveBeenCalled()
  })

  it('run:settled kind=discussion triggers discussion sub but NOT schedule sub', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'disc-x',
      workspacePath: '/p',
      reason: 'error',
      kind: 'discussion',
    })
    expect(mockBroadcastDiscussions).toHaveBeenCalledWith('/p')
    // The existing session subscription always broadcasts sessions on settle.
    expect(mockBroadcastSessions).toHaveBeenCalled()
    expect(mockBroadcastSchedules).not.toHaveBeenCalled()
  })

  it('run:settled kind=schedule triggers schedule sub but NOT discussion sub', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sch-x',
      workspacePath: '/ws',
      reason: 'aborted',
      kind: 'schedule',
    })
    expect(mockBroadcastSchedules).toHaveBeenCalledWith('/ws')
    // The existing session subscription always broadcasts sessions on settle.
    expect(mockBroadcastSessions).toHaveBeenCalled()
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  // ── run:started isolation ────────────────────────────────────────────

  it('run:started never triggers discussion or schedule settled-subscriptions', () => {
    install()
    eb.publish('run:started', { sessionId: 'x', workspacePath: '/proj', kind: 'discussion' })
    eb.publish('run:started', { sessionId: 'y', workspacePath: '/ws-a', kind: 'schedule' })
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
    expect(mockBroadcastSchedules).not.toHaveBeenCalled()
  })
})
