/**
 * WorkCenter `jumpToSource` — the per-sessionKind workspace + sessionId routing contract.
 *
 * Pins that each `sessionKind` lands on the right tab + object using the event's
 * opaque `workspaceId`, that an `intent` sessionId resolves against the loaded lists
 * (intent object → comm session → degrade), that `spec` opens the owning intent's
 * spec session, and that a never-prompting / unknown kind degrades to the console.
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Intent, IntentSessionInfo, WaitUserInvolveEvent } from '@ccc/shared/protocol'
import { installWorkcenterActions } from './workcenter-actions'
import type { AppCtx } from './types'

const WS = 'ws-1'

function intent(id: string): Intent {
  return { id } as Intent
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
    enterConsole: vi.fn(),
    openIntents: vi.fn(),
    selectIntentSession: vi.fn(),
    openSpecSession: vi.fn(),
    openDiscussions: vi.fn(),
    openDiscussion: vi.fn(),
    openSchedules: vi.fn(),
    onSelectSchedule: vi.fn(),
  }
  const requestedIntentId = ref<string | null>(null)
  const ctx = {
    ...spies,
    client: {} as never,
    currentWorkspace: ref<string | null>(WS),
    intents: ref<Record<string, Intent[]>>({ [WS]: opts.intents ?? [] }),
    intentSessions: ref<Record<string, IntentSessionInfo[]>>({ [WS]: opts.commSessions ?? [] }),
    requestedIntentId,
  } as unknown as AppCtx
  installWorkcenterActions(ctx)
  return { ctx, ...spies, requestedIntentId }
}

describe('jumpToSource', () => {
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

  it('intent + sessionId matching a known intent object → select that intent', () => {
    const { ctx, openIntents, selectIntentSession, requestedIntentId } = makeCtx({
      intents: [intent('intent-1')],
    })
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: 'intent-1' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('intent-1')
    expect(selectIntentSession).not.toHaveBeenCalled()
  })

  it('intent + sessionId matching a comm session → restore that conversation', () => {
    const { ctx, openIntents, selectIntentSession, requestedIntentId } = makeCtx({
      commSessions: [commSession('sess-1')],
    })
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: 'sess-1' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(selectIntentSession).toHaveBeenCalledWith('sess-1')
    expect(requestedIntentId.value).toBeNull()
  })

  it('intent + unresolvable sessionId → Intents tab, no selection (explicit degrade)', () => {
    const { ctx, openIntents, selectIntentSession, requestedIntentId } = makeCtx({
      intents: [intent('intent-1')],
      commSessions: [commSession('sess-1')],
    })
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: 'ghost' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(selectIntentSession).not.toHaveBeenCalled()
    expect(requestedIntentId.value).toBeNull()
  })

  it('intent without sessionId → Intents tab, no selection', () => {
    const { ctx, openIntents, selectIntentSession, requestedIntentId } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'intent', sessionId: null }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(selectIntentSession).not.toHaveBeenCalled()
    expect(requestedIntentId.value).toBeNull()
  })

  it('spec + sessionId matching the owning intent → open its spec session', () => {
    const { ctx, openIntents, openSpecSession, requestedIntentId } = makeCtx({
      intents: [intent('intent-1')],
    })
    ctx.jumpToSource(event({ sessionKind: 'spec', sessionId: 'intent-1' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(requestedIntentId.value).toBe('intent-1')
    expect(openSpecSession).toHaveBeenCalledWith('intent-1')
  })

  it('spec + unresolvable intent → Intents tab, no spec session (degrade)', () => {
    const { ctx, openIntents, openSpecSession } = makeCtx({ intents: [intent('intent-1')] })
    ctx.jumpToSource(event({ sessionKind: 'spec', sessionId: 'ghost' }))
    expect(openIntents).toHaveBeenCalledWith(WS)
    expect(openSpecSession).not.toHaveBeenCalled()
  })

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

  it('schedule + sessionId → open the schedule list and select it', () => {
    const { ctx, openSchedules, onSelectSchedule } = makeCtx()
    ctx.jumpToSource(event({ sessionKind: 'schedule', sessionId: 'sch-1' }))
    expect(openSchedules).toHaveBeenCalledWith(WS)
    expect(onSelectSchedule).toHaveBeenCalledWith('sch-1')
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
