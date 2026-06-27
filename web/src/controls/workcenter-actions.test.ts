/**
 * WorkCenter `jumpToSource` — the per-sessionKind workspace + sessionId routing contract.
 *
 * Pins that each `sessionKind` lands on the right tab + object using the event's
 * opaque `workspaceId`, that an `intent` sessionId resolves against the loaded lists
 * (intentSessionId → specSessionId → comm session → degrade), that `spec` opens the
 * owning intent's spec session, and that a never-prompting / unknown kind degrades to
 * the console.
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Intent, IntentSessionInfo, WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { installWorkcenterActions } from './workcenter-actions'
import type { AppCtx } from './types'

const WS = 'ws-1'

function intent(id: string, extra?: Partial<Intent>): Intent {
  return { id, ...extra } as Intent
}
function commSession(sessionId: string): IntentSessionInfo {
  return { sessionId, title: null, updatedAt: 1 }
}

function event(over: Partial<WaitUserInvolveEvent>): WaitUserInvolveEvent {
  return {
    id: 'e1',
    workspaceId: WS,
    sessionKind: 'work',
    sessionId: null,
    title: null,
    requestId: null,
    toolName: null,
    toolInput: null,
    status: 'todo',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as WaitUserInvolveEvent
}

function makeCtx(opts: { intents?: Intent[]; commSessions?: IntentSessionInfo[] } = {}) {
  const spies = {
    send: vi.fn(),
    setViewMode: vi.fn(),
    enterConsole: vi.fn(),
    openIntents: vi.fn(),
    selectIntentSession: vi.fn(),
    openSpecSession: vi.fn(),
    openDiscussions: vi.fn(),
    openDiscussion: vi.fn(),
    openSchedules: vi.fn(),
    onSelectSchedule: vi.fn(),
    onSelectExecution: vi.fn(),
  }
  const requestedIntentId = ref<string | null>(null)
  const requestedIntentSubTab = ref<'intentSession' | 'specSession' | null>(null)
  const requestedMergedTab = ref<'intents' | 'sessions' | null>(null)
  const ctx = {
    ...spies,
    client: {} as never,
    currentWorkspace: ref<string | null>(WS),
    intents: ref<Record<string, Intent[]>>({ [WS]: opts.intents ?? [] }),
    intentSessions: ref<Record<string, IntentSessionInfo[]>>({ [WS]: opts.commSessions ?? [] }),
    scheduleLogs: ref<Record<string, never[]>>({}),
    requestedIntentId,
    requestedIntentSubTab,
    requestedMergedTab,
  } as unknown as AppCtx
  installWorkcenterActions(ctx)
  return { ctx, ...spies, requestedIntentId, requestedIntentSubTab, requestedMergedTab }
}

describe('jumpToSource', () => {
  it('switches to workspace view mode before navigating (was missing — bug fix)', () => {
    const { ctx, setViewMode } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'work', sessionId: 's1' }))
    expect(setViewMode).toHaveBeenCalledWith('workspace')
  })

  it("work + sessionId → console + select_session by the event's workspaceId", () => {
    const { ctx, enterConsole, send } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'work', sessionId: 's1' }))
    expect(enterConsole).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith({
      type: 'select_session',
      workspaceId: WS,
      sessionId: 's1',
    })
  })

  it('work without sessionId → console only (no select_session)', () => {
    const { ctx, enterConsole, send } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'work', sessionId: null }))
    expect(enterConsole).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('never-prompting / unknown sessionKind (consensus) degrades to the console', () => {
    const { ctx, enterConsole, send } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'consensus', sessionId: 's9' }))
    expect(enterConsole).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith({
      type: 'select_session',
      workspaceId: WS,
      sessionId: 's9',
    })
  })

  // ── intent ─────────────────────────────────────────────────────────────────

  it('intent + sessionId matching intentSessionId → select intent, show intentSession tab', () => {
    const { ctx, openIntents, selectIntentSession, requestedIntentId, requestedIntentSubTab } =
      makeCtx({ intents: [intent('i1', { intentSessionId: 'sess-1' })] })
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: 'sess-1' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('i1')
    expect(requestedIntentSubTab.value).toBe('intentSession')
    expect(selectIntentSession).toHaveBeenCalledWith('sess-1')
  })

  it('intent + sessionId matching specSessionId → select intent, show specSession tab', () => {
    const { ctx, openIntents, openSpecSession, requestedIntentId, requestedIntentSubTab } = makeCtx(
      { intents: [intent('i1', { specSessionId: 'spec-1' })] },
    )
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: 'spec-1' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('i1')
    expect(requestedIntentSubTab.value).toBe('specSession')
    expect(openSpecSession).toHaveBeenCalledWith('i1')
  })

  it('intent + sessionId matching comm session → sessions tab + select session', () => {
    const { ctx, openIntents, selectIntentSession, requestedIntentId, requestedMergedTab } =
      makeCtx({ commSessions: [commSession('sess-1')] })
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: 'sess-1' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(selectIntentSession).toHaveBeenCalledWith('sess-1')
    expect(requestedIntentId.value).toBeNull()
    expect(requestedMergedTab.value).toBe('sessions')
  })

  it('intent + unresolvable sessionId → sessions tab + select session (fallback)', () => {
    const { ctx, openIntents, selectIntentSession, requestedIntentId, requestedMergedTab } =
      makeCtx({
        intents: [intent('i1')],
        commSessions: [commSession('sess-1')],
      })
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: 'ghost' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(selectIntentSession).toHaveBeenCalledWith('ghost')
    expect(requestedIntentId.value).toBeNull()
    expect(requestedMergedTab.value).toBe('sessions')
  })

  it('intent without sessionId → Intents tab, no selection', () => {
    const { ctx, openIntents, selectIntentSession, requestedIntentId } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: null }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(selectIntentSession).not.toHaveBeenCalled()
    expect(requestedIntentId.value).toBeNull()
  })

  // ── spec ───────────────────────────────────────────────────────────────────

  it('spec + sessionId matching specSessionId → open its spec session', () => {
    const { ctx, openIntents, openSpecSession, requestedIntentId, requestedIntentSubTab } = makeCtx(
      { intents: [intent('i1', { specSessionId: 'spec-1' })] },
    )
    ctx.jumpToSource(event({ sessionKind: 'spec', sessionId: 'spec-1' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('i1')
    expect(requestedIntentSubTab.value).toBe('specSession')
    // openSpecSession receives the intent id
    expect(openSpecSession).toHaveBeenCalledWith('i1')
  })

  it('spec + sessionId matching intent id (legacy) → open its spec session', () => {
    const { ctx, openIntents, openSpecSession, requestedIntentId, requestedIntentSubTab } = makeCtx(
      { intents: [intent('i1')] },
    )
    ctx.jumpToSource(event({ sessionKind: 'spec', sessionId: 'i1' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('i1')
    expect(requestedIntentSubTab.value).toBe('specSession')
    expect(openSpecSession).toHaveBeenCalledWith('i1')
  })

  it('spec + unresolvable sessionId → Intents tab, no spec session (degrade)', () => {
    const { ctx, openIntents, openSpecSession } = makeCtx({ intents: [intent('i1')] })
    ctx.jumpToSource(event({ sessionKind: 'spec', sessionId: 'ghost' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(openSpecSession).not.toHaveBeenCalled()
  })

  // ── discussion / schedule / fallback ───────────────────────────────────────

  it('discussion + sessionId → open the discussion list and select it', () => {
    const { ctx, openDiscussions, openDiscussion } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'discussion', sessionId: 'disc-1' }))
    expect(openDiscussions).toHaveBeenCalledWith(WS)
    expect(openDiscussion).toHaveBeenCalledWith('disc-1')
  })

  it('discussion without sessionId → list only (degrade)', () => {
    const { ctx, openDiscussions, openDiscussion } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'discussion', sessionId: null }))
    expect(openDiscussions).toHaveBeenCalledWith(WS)
    expect(openDiscussion).not.toHaveBeenCalled()
  })

  it('schedule + sessionId → open schedule list, no detail if logs not loaded', () => {
    const { ctx, openSchedules, onSelectSchedule, onSelectExecution } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'schedule', sessionId: 'exec-sess-1' }))
    expect(openSchedules).toHaveBeenCalledWith(WS)
    // When scheduleLogs is empty, degrades to list only
    expect(onSelectSchedule).not.toHaveBeenCalled()
    expect(onSelectExecution).not.toHaveBeenCalled()
  })

  it('schedule + sessionId matching loaded execution log → select schedule + execution', () => {
    const { ctx, openSchedules, onSelectSchedule, onSelectExecution } = makeCtx()
    // Simulate loaded schedule logs
    ctx.scheduleLogs.value = {
      'sch-1': [{ id: 'exec-1', scheduleId: 'sch-1', sessionId: 'exec-sess-1' } as never],
    }
    ctx.jumpToSource(event({ sessionKind: 'schedule', sessionId: 'exec-sess-1' }))
    expect(openSchedules).toHaveBeenCalledWith(WS)
    expect(onSelectSchedule).toHaveBeenCalledWith('sch-1')
    expect(onSelectExecution).toHaveBeenCalledWith('exec-1')
  })

  it('falls back to currentWorkspace when the event carries no workspaceId', () => {
    const { ctx, send } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'work', sessionId: 's1', workspaceId: '' }))
    expect(send).toHaveBeenCalledWith({
      type: 'select_session',
      workspaceId: WS,
      sessionId: 's1',
    })
  })
})
