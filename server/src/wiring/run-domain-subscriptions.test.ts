/**
 * Tests for resident domain subscriptions — discussion and automation lifecycle
 * events that arrived in 2026-06-08-010 (discussion / automation run bus).
 *
 * Subscriptions to cover:
 *  1. `run:settled` + sessionKind=discussion → broadcastDiscussions
 *  2. `run:settled` + sessionKind=automation   → broadcastAutomations
 *  3. `run:started` + sessionKind=automation   → broadcastAutomations (so the
 *     list's live-session indicator lights up without polling)
 *  4. Cross-sessionKind isolation (session/discussion/automation don't leak into each
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
  setBranchName: vi.fn(),
  setIntentSessionId: vi.fn(),
  setLastWorkSession: vi.fn(),
  setLatestCommitHash: vi.fn(),
  setPrInfo: vi.fn(),
  setSpecSessionId: vi.fn(),
  updateIntentSession: vi.fn(),
  updateStatus: vi.fn(),
  listIntents: vi.fn(() => []),
}))
vi.mock('../features/sessions/session-metadata-store.js', () => ({
  deleteByPendingId: vi.fn(),
  deleteByVendorId: vi.fn(),
  updateRowOwner: vi.fn(),
  upsertBoundRow: vi.fn(),
}))
vi.mock('../features/intents/dev-link.js', () => ({
  clearPendingDevLink: vi.fn(() => undefined),
  releaseDevLaunch: vi.fn(),
  takePendingDevLink: vi.fn(() => null),
}))
vi.mock('../features/intents/spec-link.js', () => ({
  clearPendingSpecLink: vi.fn(() => undefined),
  takePendingSpecLink: vi.fn(() => null),
}))
vi.mock('../features/intents/intent-link.js', () => ({
  clearPendingIntentLink: vi.fn(() => undefined),
  takePendingIntentLink: vi.fn(() => null),
}))
vi.mock('../features/intents/workflow.js', () => ({
  notifyTurnSettled: vi.fn(),
  isIntentDrivenByWorkflow: vi.fn(() => false),
}))
vi.mock('../features/intents/dev-cleanup.js', () => ({
  runManualDevCleanup: vi.fn(async () => ({ kind: 'skipped' })),
}))
vi.mock('../features/intents/worktree.js', () => ({
  getWorktreePath: vi.fn((ws: string, id: string) => `${ws}/.wt/${id}`),
}))
vi.mock('../kernel/config/index.js', () => ({
  getGitBranchMode: vi.fn(() => 'current-branch'),
  getDefaultMainBranch: vi.fn(() => 'main'),
  getForgeOverride: vi.fn(() => undefined),
  getSessionAgentId: vi.fn(() => 'agent-1'),
}))
vi.mock('../features/user-involve/store.js', () => ({
  cancelBySessionId: vi.fn(),
  createEvent: vi.fn(),
  isStoreAvailable: vi.fn(() => true),
}))
vi.mock('../kernel/agent-config/index.js', () => ({
  resolveSessionVendor: vi.fn(() => 'claude'),
  resolveSessionAgentSwitch: vi.fn(() => ({ agent: { vendor: 'claude' } })),
}))
vi.mock('../git.js', () => ({
  gitDiffStat: vi.fn(async () => 'file.ts | 10 +++'),
  hasCommittableChanges: vi.fn(async () => true),
  getHeadCommit: vi.fn(async () => 'abc1234'),
  getCurrentBranch: vi.fn(async () => 'feature/x'),
  commitAndPush: vi.fn(async () => ({ ok: true, committed: true })),
  createGhPr: vi.fn(async () => ({ ok: true, prId: '1', prUrl: 'http://x/pull/1' })),
}))

// Dynamic import so all vi.mocks are in place first.
const { registerRunDomainSubscriptions } = await import('./run-domain-subscriptions.js')

describe('resident domain subscriptions — discussion + automation', () => {
  let eb: EventBus
  const mockBroadcastDiscussions = vi.fn()
  const mockBroadcastAutomations = vi.fn()
  const mockBroadcastSessions = vi.fn()
  const mockBroadcastIntents = vi.fn()
  const mockBroadcastIntentSessions = vi.fn()
  const mockBroadcastWaitUserEvents = vi.fn()
  const mockPublishEvent = vi.fn()

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
      broadcastAutomations: mockBroadcastAutomations,
      broadcastWaitUserEvents: mockBroadcastWaitUserEvents,
      normalizeEvent: () => ({ ok: false, reason: 'not wired in this test' }),
      publishEvent: mockPublishEvent,
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

  it('discussion sub: run:settled with sessionKind=discussion fires broadcastDiscussions', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'disc-1',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'discussion',
      runKind: 'internal',
    })
    expect(mockBroadcastDiscussions).toHaveBeenCalledWith('/proj')
    expect(mockBroadcastDiscussions).toHaveBeenCalledTimes(1)
    expect(mockBroadcastAutomations).not.toHaveBeenCalled()
  })

  it('discussion sub: run:settled with sessionKind=work does NOT fire broadcastDiscussions', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sess-1',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  it('discussion sub: run:settled with sessionKind=automation does NOT fire broadcastDiscussions', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sch-1',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'automation',
      runKind: 'headless',
    })
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  // ── Automation subscription ────────────────────────────────────────────

  it('automation sub: run:settled with sessionKind=automation fires broadcastAutomations', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'log-1',
      workspacePath: '/ws-a',
      reason: 'complete',
      sessionKind: 'automation',
      runKind: 'headless',
    })
    expect(mockBroadcastAutomations).toHaveBeenCalledWith('/ws-a')
    expect(mockBroadcastAutomations).toHaveBeenCalledTimes(1)
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  it('automation sub: run:settled with sessionKind=work does NOT fire broadcastAutomations', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sess-1',
      workspacePath: '/ws-a',
      reason: 'error',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(mockBroadcastAutomations).not.toHaveBeenCalled()
  })

  it('automation sub: run:settled with sessionKind=discussion does NOT fire broadcastAutomations', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'disc-1',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'discussion',
      runKind: 'internal',
    })
    expect(mockBroadcastAutomations).not.toHaveBeenCalled()
  })

  // ── Cross-sessionKind isolation ─────────────────────────────────────────────

  it('run:settled sessionKind=work fires ONLY the existing broadcastSessions', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sess-x',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(mockBroadcastSessions).toHaveBeenCalledWith('/proj')
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
    expect(mockBroadcastAutomations).not.toHaveBeenCalled()
  })

  it('run:settled sessionKind=discussion triggers discussion sub but NOT automation sub', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'disc-x',
      workspacePath: '/p',
      reason: 'error',
      sessionKind: 'discussion',
      runKind: 'internal',
    })
    expect(mockBroadcastDiscussions).toHaveBeenCalledWith('/p')
    // The existing session subscription always broadcasts sessions on settle.
    expect(mockBroadcastSessions).toHaveBeenCalled()
    expect(mockBroadcastAutomations).not.toHaveBeenCalled()
  })

  it('run:settled sessionKind=automation triggers automation sub but NOT discussion sub', () => {
    install()
    eb.publish('run:settled', {
      sessionId: 'sch-x',
      workspacePath: '/ws',
      reason: 'aborted',
      sessionKind: 'automation',
      runKind: 'headless',
    })
    expect(mockBroadcastAutomations).toHaveBeenCalledWith('/ws')
    // The existing session subscription always broadcasts sessions on settle.
    expect(mockBroadcastSessions).toHaveBeenCalled()
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  // ── run:started isolation ────────────────────────────────────────────

  it('run:started never triggers the discussion subscription', () => {
    install()
    eb.publish('run:started', {
      sessionId: 'x',
      workspacePath: '/proj',
      sessionKind: 'discussion',
      runKind: 'internal',
    })
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  it('automation sub: run:started with sessionKind=automation fires broadcastAutomations', () => {
    install()
    eb.publish('run:started', {
      sessionId: 'log-1',
      workspacePath: '/ws-a',
      sessionKind: 'automation',
      runKind: 'headless',
    })
    expect(mockBroadcastAutomations).toHaveBeenCalledWith('/ws-a')
    expect(mockBroadcastAutomations).toHaveBeenCalledTimes(1)
    expect(mockBroadcastDiscussions).not.toHaveBeenCalled()
  })

  it('automation sub: run:started of another sessionKind does NOT fire broadcastAutomations', () => {
    install()
    for (const sessionKind of ['work', 'discussion', 'intent', 'spec'] as const) {
      eb.publish('run:started', {
        sessionId: `s-${sessionKind}`,
        workspacePath: '/proj',
        sessionKind,
        runKind: 'interactive',
      })
    }
    expect(mockBroadcastAutomations).not.toHaveBeenCalled()
  })

  // ── Wait-user-involve event cancel on run:settled (sessionKind=work) ────

  it('run:settled sessionKind=work cancels events and broadcasts via broadcastWaitUserEvents', async () => {
    install()
    const { cancelBySessionId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'sess-x',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(cancelBySessionId).toHaveBeenCalledWith('sess-x')
    expect(mockBroadcastWaitUserEvents).toHaveBeenCalledWith('/proj')
  })

  it('run:settled sessionKind=work (error reason) cancels events and broadcasts', async () => {
    install()
    const { cancelBySessionId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'sess-y',
      workspacePath: '/proj',
      reason: 'error',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(cancelBySessionId).toHaveBeenCalledWith('sess-y')
    expect(mockBroadcastWaitUserEvents).toHaveBeenCalledWith('/proj')
  })

  it('rolls an unbound intent work run back to todo and deletes its pending projection', async () => {
    install()
    const devLink = await import('../features/intents/dev-link.js')
    const store = await import('../features/intents/store.js')
    const metadata = await import('../features/sessions/session-metadata-store.js')
    vi.mocked(devLink.clearPendingDevLink).mockReturnValueOnce('intent-1')
    vi.mocked(store.getIntent).mockReturnValueOnce({
      id: 'intent-1',
      workspacePath: '/proj',
      title: 'Sandbox work',
      content: '',
      priority: 'medium',
      module: '',
      status: 'in_progress',
      dependsOn: [],
      lastWorkSessionId: null,
    } as unknown as Intent)

    eb.publish('run:settled', {
      sessionId: 'pending:failed',
      workspacePath: '/proj',
      reason: 'error',
      sessionKind: 'work',
      runKind: 'interactive',
    })

    expect(devLink.releaseDevLaunch).toHaveBeenCalledWith('intent-1')
    expect(metadata.deleteByPendingId).toHaveBeenCalledWith('pending:failed')
    expect(store.updateStatus).toHaveBeenCalledWith('intent-1', 'todo')
    expect(mockBroadcastIntents).toHaveBeenCalledWith('/proj')
  })

  it('run:settled sessionKind=work (aborted reason) cancels events and broadcasts', async () => {
    install()
    const { cancelBySessionId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'sess-z',
      workspacePath: '/proj',
      reason: 'aborted',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(cancelBySessionId).toHaveBeenCalledWith('sess-z')
    expect(mockBroadcastWaitUserEvents).toHaveBeenCalledWith('/proj')
  })

  it('run:settled sessionKind=discussion does NOT cancel events or broadcastWaitUserEvents', async () => {
    install()
    const { cancelBySessionId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'disc-x',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'discussion',
      runKind: 'internal',
    })
    expect(cancelBySessionId).not.toHaveBeenCalled()
    expect(mockBroadcastWaitUserEvents).not.toHaveBeenCalled()
  })

  it('run:settled sessionKind=automation does NOT cancel events or broadcastWaitUserEvents', async () => {
    install()
    const { cancelBySessionId } = await import('../features/user-involve/store.js')
    eb.publish('run:settled', {
      sessionId: 'sch-x',
      workspacePath: '/ws',
      reason: 'complete',
      sessionKind: 'automation',
      runKind: 'headless',
    })
    expect(cancelBySessionId).not.toHaveBeenCalled()
    expect(mockBroadcastWaitUserEvents).not.toHaveBeenCalled()
  })

  it('run:settled sessionKind=work skips when events store is unavailable', async () => {
    const store = await import('../features/user-involve/store.js')
    vi.mocked(store.isStoreAvailable).mockReturnValueOnce(false)
    install()
    eb.publish('run:settled', {
      sessionId: 'sess-x',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    expect(mockBroadcastWaitUserEvents).not.toHaveBeenCalled()
  })

  // ── Intent-sessions: insert at run:bound ──────────────────────────────

  it('run:bound with pending dev link inserts intent_sessions record', async () => {
    const { getRuntime } = await import('../runs.js')
    const { takePendingDevLink } = await import('../features/intents/dev-link.js')
    const { insertIntentSession } = await import('../features/intents/store.js')
    const { resolveSessionVendor } = await import('../kernel/agent-config/index.js')
    const { updateRowOwner } = await import('../features/sessions/session-metadata-store.js')

    vi.mocked(getRuntime).mockReturnValueOnce({
      workspacePath: '/proj',
      sessionKind: 'work',
      runKind: 'interactive',
      mode: 'edit',
      buffer: [],
      viewers: new Set(),
    } as unknown as SessionRuntime)
    vi.mocked(takePendingDevLink).mockReturnValueOnce('intent-1')
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')

    install()

    eb.publish('run:bound', { prevId: 'prev-1', realId: 'real-1', workspacePath: '/proj' })

    expect(insertIntentSession).toHaveBeenCalledWith('intent-1', 'real-1', 'codex')
    expect(updateRowOwner).toHaveBeenCalledWith({
      sessionId: 'real-1',
      vendor: 'codex',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    })
  })

  it('run:bound with NO pending dev link does NOT insert intent_sessions', async () => {
    const { insertIntentSession } = await import('../features/intents/store.js')
    install()
    eb.publish('run:bound', { prevId: 'prev-x', realId: 'real-x', workspacePath: '/proj' })
    expect(insertIntentSession).not.toHaveBeenCalled()
  })

  // ── Spec-sessions: backfill spec_session_id at run:bound ───────────────

  it('run:bound on a spec runtime links the real spec session id onto the intent', async () => {
    const { getRuntime } = await import('../runs.js')
    const { takePendingSpecLink } = await import('../features/intents/spec-link.js')
    const { getIntent, setSpecSessionId } = await import('../features/intents/store.js')
    const { deleteByVendorId, updateRowOwner, upsertBoundRow } =
      await import('../features/sessions/session-metadata-store.js')

    vi.mocked(getRuntime).mockReturnValueOnce({
      workspacePath: '/proj',
      sessionKind: 'spec',
      runKind: 'interactive',
      mode: 'default',
      buffer: [],
      viewers: new Set(),
    } as unknown as SessionRuntime)
    vi.mocked(takePendingSpecLink).mockReturnValueOnce('intent-9')
    vi.mocked(getIntent).mockReturnValueOnce({
      id: 'intent-9',
      title: 'Spec target',
      specSessionId: 'old-spec',
    } as Intent)

    install()
    eb.publish('run:bound', { prevId: 'pending-9', realId: 'real-9', workspacePath: '/proj' })

    expect(takePendingSpecLink).toHaveBeenCalledWith('pending-9')
    expect(updateRowOwner).toHaveBeenCalledWith({
      sessionId: 'old-spec',
      vendor: 'codex',
      ownerKind: null,
      ownerId: null,
    })
    expect(setSpecSessionId).toHaveBeenCalledWith('intent-9', 'real-9')
    expect(deleteByVendorId).toHaveBeenCalledWith('codex', 'pending-9')
    expect(upsertBoundRow).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'real-9',
        workspacePath: '/proj',
        sessionKind: 'spec',
        ownerKind: 'intent',
        ownerId: 'intent-9',
        title: 'Spec target',
      }),
    )
    expect(mockBroadcastIntents).toHaveBeenCalledWith('/proj')
  })

  it('run:settled sessionKind=spec sweeps the pending spec link', async () => {
    const { clearPendingSpecLink } = await import('../features/intents/spec-link.js')
    install()
    eb.publish('run:settled', {
      sessionId: 'spec-x',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'spec',
      runKind: 'interactive',
    })
    expect(clearPendingSpecLink).toHaveBeenCalledWith('spec-x')
  })

  // ── Intent-sessions: backfill intent_session_id at run:bound (refine) ───

  it('run:bound on a refining intent runtime backfills intent_session_id', async () => {
    const { getRuntime } = await import('../runs.js')
    const { takePendingIntentLink } = await import('../features/intents/intent-link.js')
    const { setIntentSessionId } = await import('../features/intents/store.js')
    const { resolveSessionVendor } = await import('../kernel/agent-config/index.js')
    const { deleteByVendorId, upsertBoundRow } =
      await import('../features/sessions/session-metadata-store.js')
    vi.mocked(resolveSessionVendor).mockReturnValue('claude')

    vi.mocked(getRuntime).mockReturnValue({
      workspacePath: '/proj',
      sessionKind: 'intent',
      runKind: 'interactive',
      mode: 'default',
      buffer: [],
      viewers: new Set(),
    } as unknown as SessionRuntime)
    vi.mocked(takePendingIntentLink).mockReturnValueOnce('intent-7')

    install()
    eb.publish('run:bound', { prevId: 'pending-7', realId: 'real-7', workspacePath: '/proj' })

    expect(takePendingIntentLink).toHaveBeenCalledWith('pending-7')
    expect(setIntentSessionId).toHaveBeenCalledWith('intent-7', 'real-7')
    expect(deleteByVendorId).toHaveBeenCalledWith('claude', 'pending-7')
    expect(upsertBoundRow).toHaveBeenCalledWith({
      sessionId: 'real-7',
      workspacePath: '/proj',
      vendor: 'claude',
      agentId: 'agent-1',
      title: 'New Intent',
      sessionKind: 'intent',
      ownerKind: 'intent',
      ownerId: 'intent-7',
    })
    expect(mockBroadcastIntents).toHaveBeenCalledWith('/proj')

    vi.mocked(getRuntime).mockReturnValue(undefined as unknown as SessionRuntime)
  })

  it('run:bound on a non-refine intent runtime does NOT backfill intent_session_id', async () => {
    const { getRuntime } = await import('../runs.js')
    const { setIntentSessionId } = await import('../features/intents/store.js')
    const { resolveSessionVendor } = await import('../kernel/agent-config/index.js')
    const { upsertBoundRow } = await import('../features/sessions/session-metadata-store.js')
    vi.mocked(resolveSessionVendor).mockReturnValue('claude')

    vi.mocked(getRuntime).mockReturnValue({
      workspacePath: '/proj',
      sessionKind: 'intent',
      runKind: 'interactive',
      mode: 'default',
      buffer: [],
      viewers: new Set(),
    } as unknown as SessionRuntime)
    // takePendingIntentLink default returns null → no backfill.

    install()
    eb.publish('run:bound', { prevId: 'pending-n', realId: 'real-n', workspacePath: '/proj' })

    expect(setIntentSessionId).not.toHaveBeenCalled()
    expect(upsertBoundRow).toHaveBeenCalledWith({
      sessionId: 'real-n',
      workspacePath: '/proj',
      vendor: 'claude',
      agentId: 'agent-1',
      title: 'New Intent',
      sessionKind: 'intent',
      ownerKind: null,
      ownerId: null,
    })

    vi.mocked(getRuntime).mockReturnValue(undefined as unknown as SessionRuntime)
  })

  it('run:settled sessionKind=intent sweeps the pending intent link', async () => {
    const { clearPendingIntentLink } = await import('../features/intents/intent-link.js')
    install()
    eb.publish('run:settled', {
      sessionId: 'intent-x',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'intent',
      runKind: 'interactive',
    })
    expect(clearPendingIntentLink).toHaveBeenCalledWith('intent-x')
  })

  // ── Intent-sessions: write conclusion at run:settled ───────────────────

  it('run:settled sessionKind=work matched to intent writes conclusion with git diff', async () => {
    const { listIntents, getIntentSessionBySessionId, updateIntentSession } =
      await import('../features/intents/store.js')

    vi.mocked(listIntents).mockReturnValueOnce([
      {
        id: 'intent-1',
        lastWorkSessionId: 'sess-m1',
        title: 'Test',
        workspaceId: '/proj',
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
      sessionKind: 'work',
      runKind: 'interactive',
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

  // ── Manual vs automation session-end cleanup dispatch (MSC-R1) ──
  it('run:settled sessionKind=work: a manual matched session triggers runManualDevCleanup', async () => {
    const { listIntents } = await import('../features/intents/store.js')
    const { isIntentDrivenByWorkflow } = await import('../features/intents/workflow.js')
    const { runManualDevCleanup } = await import('../features/intents/dev-cleanup.js')

    vi.mocked(listIntents).mockReturnValueOnce([
      { id: 'intent-man', lastWorkSessionId: 'sess-man', title: 'M' } as Intent,
    ])
    vi.mocked(isIntentDrivenByWorkflow).mockReturnValueOnce(false)

    install()
    eb.publish('run:settled', {
      sessionId: 'sess-man',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })

    await vi.waitFor(() => {
      expect(runManualDevCleanup).toHaveBeenCalledWith(
        'intent-man',
        '/proj',
        expect.anything(),
        'sess-man',
      )
    })
  })

  it('run:settled sessionKind=work: an automation-owned session does NOT trigger cleanup', async () => {
    const { listIntents } = await import('../features/intents/store.js')
    const { isIntentDrivenByWorkflow } = await import('../features/intents/workflow.js')
    const { runManualDevCleanup } = await import('../features/intents/dev-cleanup.js')

    vi.mocked(listIntents).mockReturnValueOnce([
      { id: 'intent-auto', lastWorkSessionId: 'sess-auto', title: 'A' } as Intent,
    ])
    vi.mocked(isIntentDrivenByWorkflow).mockReturnValueOnce(true)

    install()
    eb.publish('run:settled', {
      sessionId: 'sess-auto',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })

    // Give the (not-expected) fire-and-forget a tick; it must never be called.
    await new Promise((r) => setTimeout(r, 10))
    expect(runManualDevCleanup).not.toHaveBeenCalled()
  })

  it('run:settled matched intent with error reason writes failure exit_code', async () => {
    const { listIntents, getIntentSessionBySessionId, updateIntentSession } =
      await import('../features/intents/store.js')

    vi.mocked(listIntents).mockReturnValueOnce([
      { id: 'intent-2', lastWorkSessionId: 'sess-e1', title: 'Error Intent' } as Intent,
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
      sessionKind: 'work',
      runKind: 'interactive',
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
      { id: 'intent-3', lastWorkSessionId: 'sess-a1', title: 'Aborted Intent' } as Intent,
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
      sessionKind: 'work',
      runKind: 'interactive',
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
      { id: 'intent-4', lastWorkSessionId: 'sess-n1', title: 'No Record Intent' } as Intent,
    ])
    // getIntentSessionBySessionId returns null (default mock)
    vi.mocked(getIntentSessionBySessionId).mockReturnValueOnce(null)

    install()
    eb.publish('run:settled', {
      sessionId: 'sess-n1',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })

    // Small delay to let the async settle.
    await Promise.resolve()
    expect(updateIntentSession).not.toHaveBeenCalled()
  })

  it('run:settled sessionKind=work NOT matched to intent — no intent session write', async () => {
    const { listIntents, updateIntentSession } = await import('../features/intents/store.js')
    // listIntents returns an array with no matching lastWorkSessionId
    vi.mocked(listIntents).mockReturnValueOnce([
      { id: 'intent-other', lastWorkSessionId: 'other-sess' } as Intent,
    ])

    install()
    eb.publish('run:settled', {
      sessionId: 'unmatched-sess',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'work',
      runKind: 'interactive',
    })

    await Promise.resolve()
    expect(updateIntentSession).not.toHaveBeenCalled()
  })

  it('run:settled sessionKind=discussion does NOT trigger intent session write', async () => {
    const { updateIntentSession } = await import('../features/intents/store.js')

    install()
    eb.publish('run:settled', {
      sessionId: 'disc-x',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'discussion',
      runKind: 'internal',
    })

    await Promise.resolve()
    expect(updateIntentSession).not.toHaveBeenCalled()
  })

  it('run:settled sessionKind=automation does NOT trigger intent session write', async () => {
    const { updateIntentSession } = await import('../features/intents/store.js')

    install()
    eb.publish('run:settled', {
      sessionId: 'sch-x',
      workspacePath: '/proj',
      reason: 'complete',
      sessionKind: 'automation',
      runKind: 'headless',
    })

    await Promise.resolve()
    expect(updateIntentSession).not.toHaveBeenCalled()
  })
})
