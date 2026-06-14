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
import type { SessionRuntime } from '../runs.js'
import type { Intent, IntentDevSession } from '@ccc/shared/protocol'

// ---------------------------------------------------------------------------
// Mock the feature modules that registerRunDomainSubscriptions depends on
// (we only test the subscription dispatch, not the real state).
// ---------------------------------------------------------------------------
vi.mock('../runs.js', () => ({ getRuntime: vi.fn(() => undefined) }))
vi.mock('../state.js', () => ({ setSessionMode: vi.fn() }))
vi.mock('../features/intents/store.js', () => ({
  getIntent: vi.fn(),
  getIntentSessionBySessionId: vi.fn(() => null),
  insertIntentSession: vi.fn(),
  rebindChatSession: vi.fn(),
  setLastDevSession: vi.fn(),
  updateIntentSession: vi.fn(),
  updateStatus: vi.fn(),
  listIntents: vi.fn(() => []),
}))
vi.mock('../features/intents/dev-link.js', () => ({
  clearPendingDevLink: vi.fn(() => undefined),
  releaseDevLaunch: vi.fn(),
  takePendingDevLink: vi.fn(() => null),
}))
vi.mock('../features/intents/automation.js', () => ({ notifyTurnSettled: vi.fn() }))
vi.mock('../features/user-involve/store.js', () => ({
  cancelBySourceId: vi.fn(),
  isStoreAvailable: vi.fn(() => true),
}))
vi.mock('../kernel/agent-config/index.js', () => ({
  resolveSessionVendor: vi.fn(() => 'claude'),
  resolveSessionAgentSwitch: vi.fn(() => ({ agent: { vendor: 'claude' } })),
}))
vi.mock('../git.js', () => ({ gitDiffStat: vi.fn(async () => 'file.ts | 10 +++') }))

// Dynamic import so all vi.mocks are in place first.
const { registerRunDomainSubscriptions } = await import('./run-domain-subscriptions.js')

describe('resident domain subscriptions — discussion + schedule', () => {
  let eb: EventBus
  const mockBroadcastDiscussions = vi.fn()
  const mockBroadcastSchedules = vi.fn()
  const mockBroadcastSessions = vi.fn()
  const mockBroadcastIntents = vi.fn()
  const mockBroadcastIntentSessions = vi.fn()
  const mockBroadcastWaitUserEvents = vi.fn()

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
      broadcastWaitUserEvents: mockBroadcastWaitUserEvents,
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

  // ── Wait-user-involve event cancel on run:settled (kind=session) ────

  it('run:settled kind=session cancels events and broadcasts via broadcastWaitUserEvents', async () => {
    install()
    const { cancelBySourceId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'sess-x',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'session',
    })
    expect(cancelBySourceId).toHaveBeenCalledWith('sess-x')
    expect(mockBroadcastWaitUserEvents).toHaveBeenCalledWith('/proj')
  })

  it('run:settled kind=session (error reason) cancels events and broadcasts', async () => {
    install()
    const { cancelBySourceId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'sess-y',
      workspacePath: '/proj',
      reason: 'error',
      kind: 'session',
    })
    expect(cancelBySourceId).toHaveBeenCalledWith('sess-y')
    expect(mockBroadcastWaitUserEvents).toHaveBeenCalledWith('/proj')
  })

  it('run:settled kind=session (aborted reason) cancels events and broadcasts', async () => {
    install()
    const { cancelBySourceId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'sess-z',
      workspacePath: '/proj',
      reason: 'aborted',
      kind: 'session',
    })
    expect(cancelBySourceId).toHaveBeenCalledWith('sess-z')
    expect(mockBroadcastWaitUserEvents).toHaveBeenCalledWith('/proj')
  })

  it('run:settled kind=discussion does NOT cancel events or broadcastWaitUserEvents', async () => {
    install()
    const { cancelBySourceId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'disc-x',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'discussion',
    })
    expect(cancelBySourceId).not.toHaveBeenCalled()
    expect(mockBroadcastWaitUserEvents).not.toHaveBeenCalled()
  })

  it('run:settled kind=schedule does NOT cancel events or broadcastWaitUserEvents', async () => {
    install()
    const { cancelBySourceId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'sch-x',
      workspacePath: '/ws',
      reason: 'complete',
      kind: 'schedule',
    })
    expect(cancelBySourceId).not.toHaveBeenCalled()
    expect(mockBroadcastWaitUserEvents).not.toHaveBeenCalled()
  })

  it('run:settled kind=session skips when events store is unavailable', async () => {
    const store = await import('../features/user-involve/store.js')
    vi.mocked(store.isStoreAvailable).mockReturnValueOnce(false)
    install()
    eb.publish('run:settled', {
      sessionId: 'sess-x',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'session',
    })
    expect(mockBroadcastWaitUserEvents).not.toHaveBeenCalled()
  })

  // ── Intent-sessions: insert at run:bound ──────────────────────────────

  it('run:bound with pending dev link inserts intent_sessions record', async () => {
    const { getRuntime } = await import('../runs.js')
    const { takePendingDevLink } = await import('../features/intents/dev-link.js')
    const { insertIntentSession } = await import('../features/intents/store.js')
    const { resolveSessionVendor } = await import('../kernel/agent-config/index.js')

    vi.mocked(getRuntime).mockReturnValueOnce({
      workspacePath: '/proj',
      kind: 'session',
      mode: 'edit',
      buffer: [],
      viewers: new Set(),
    } as unknown as SessionRuntime)
    vi.mocked(takePendingDevLink).mockReturnValueOnce('intent-1')
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')

    install()

    eb.publish('run:bound', { prevId: 'prev-1', realId: 'real-1', workspacePath: '/proj' })

    expect(insertIntentSession).toHaveBeenCalledWith('intent-1', 'real-1', 'codex')
  })

  it('run:bound with NO pending dev link does NOT insert intent_sessions', async () => {
    const { insertIntentSession } = await import('../features/intents/store.js')
    install()
    eb.publish('run:bound', { prevId: 'prev-x', realId: 'real-x', workspacePath: '/proj' })
    expect(insertIntentSession).not.toHaveBeenCalled()
  })

  // ── Intent-sessions: write conclusion at run:settled ───────────────────

  it('run:settled kind=session matched to intent writes conclusion with git diff', async () => {
    const { listIntents, getIntentSessionBySessionId, updateIntentSession } =
      await import('../features/intents/store.js')

    vi.mocked(listIntents).mockReturnValueOnce([
      {
        id: 'intent-1',
        lastDevSessionId: 'sess-m1',
        title: 'Test',
        workspacePath: '/proj',
      } as Intent,
    ])
    vi.mocked(getIntentSessionBySessionId).mockReturnValueOnce({
      id: 42,
      intentId: 'intent-1',
      sessionId: 'sess-m1',
    } as unknown as IntentDevSession)

    install()
    eb.publish('run:settled', {
      sessionId: 'sess-m1',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'session',
    })

    // Wait for the fire-and-forget async to complete.
    await vi.waitFor(() => {
      expect(updateIntentSession).toHaveBeenCalled()
    })

    const call = vi.mocked(updateIntentSession).mock.calls[0]!
    const id = call[0]
    const patch = call[1] as Partial<{ exitCode: string; summary: string; endAt: number }>
    expect(id).toBe(42)
    expect(patch.exitCode).toBe('success')
    expect(patch.endAt).toBeGreaterThan(0)
    expect(patch.summary).toContain('exitCode')
    expect(patch.summary).toContain('success')
    expect(patch.summary).toContain('file.ts | 10 +++')
  })

  it('run:settled matched intent with error reason writes failure exit_code', async () => {
    const { listIntents, getIntentSessionBySessionId, updateIntentSession } =
      await import('../features/intents/store.js')

    vi.mocked(listIntents).mockReturnValueOnce([
      { id: 'intent-2', lastDevSessionId: 'sess-e1', title: 'Error Intent' } as Intent,
    ])
    vi.mocked(getIntentSessionBySessionId).mockReturnValueOnce({
      id: 99,
      intentId: 'intent-2',
      sessionId: 'sess-e1',
    } as unknown as IntentDevSession)

    install()
    eb.publish('run:settled', {
      sessionId: 'sess-e1',
      workspacePath: '/proj',
      reason: 'error',
      kind: 'session',
    })

    await vi.waitFor(() => {
      expect(updateIntentSession).toHaveBeenCalled()
    })

    const patch = vi.mocked(updateIntentSession).mock.calls[0]![1] as Partial<{ exitCode: string }>
    expect(patch.exitCode).toBe('failure')
  })

  it('run:settled matched intent with aborted reason writes cancelled exit_code', async () => {
    const { listIntents, getIntentSessionBySessionId, updateIntentSession } =
      await import('../features/intents/store.js')

    vi.mocked(listIntents).mockReturnValueOnce([
      { id: 'intent-3', lastDevSessionId: 'sess-a1', title: 'Aborted Intent' } as Intent,
    ])
    vi.mocked(getIntentSessionBySessionId).mockReturnValueOnce({
      id: 77,
      intentId: 'intent-3',
      sessionId: 'sess-a1',
    } as unknown as IntentDevSession)

    install()
    eb.publish('run:settled', {
      sessionId: 'sess-a1',
      workspacePath: '/proj',
      reason: 'aborted',
      kind: 'session',
    })

    await vi.waitFor(() => {
      expect(updateIntentSession).toHaveBeenCalled()
    })

    const patch = vi.mocked(updateIntentSession).mock.calls[0]![1] as Partial<{ exitCode: string }>
    expect(patch.exitCode).toBe('cancelled')
  })

  it('run:settled matched intent with NO intent session record — no error, no update', async () => {
    const { listIntents, getIntentSessionBySessionId, updateIntentSession } =
      await import('../features/intents/store.js')

    vi.mocked(listIntents).mockReturnValueOnce([
      { id: 'intent-4', lastDevSessionId: 'sess-n1', title: 'No Record Intent' } as Intent,
    ])
    // getIntentSessionBySessionId returns null (default mock)
    vi.mocked(getIntentSessionBySessionId).mockReturnValueOnce(null)

    install()
    eb.publish('run:settled', {
      sessionId: 'sess-n1',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'session',
    })

    // Small delay to let the async settle.
    await Promise.resolve()
    expect(updateIntentSession).not.toHaveBeenCalled()
  })

  it('run:settled kind=session NOT matched to intent — no intent session write', async () => {
    const { listIntents, updateIntentSession } = await import('../features/intents/store.js')
    // listIntents returns an array with no matching lastDevSessionId
    vi.mocked(listIntents).mockReturnValueOnce([
      { id: 'intent-other', lastDevSessionId: 'other-sess' } as Intent,
    ])

    install()
    eb.publish('run:settled', {
      sessionId: 'unmatched-sess',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'session',
    })

    await Promise.resolve()
    expect(updateIntentSession).not.toHaveBeenCalled()
  })

  it('run:settled kind=discussion does NOT trigger intent session write', async () => {
    const { updateIntentSession } = await import('../features/intents/store.js')

    install()
    eb.publish('run:settled', {
      sessionId: 'disc-x',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'discussion',
    })

    await Promise.resolve()
    expect(updateIntentSession).not.toHaveBeenCalled()
  })

  it('run:settled kind=schedule does NOT trigger intent session write', async () => {
    const { updateIntentSession } = await import('../features/intents/store.js')

    install()
    eb.publish('run:settled', {
      sessionId: 'sch-x',
      workspacePath: '/proj',
      reason: 'complete',
      kind: 'schedule',
    })

    await Promise.resolve()
    expect(updateIntentSession).not.toHaveBeenCalled()
  })
})
