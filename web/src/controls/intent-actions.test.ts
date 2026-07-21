/**
 * Control-layer wiring for the post-Start-Dev jump: a `ready` close arms a ~1s
 * delayed jump that stays on the intents page — it binds the intent's new work
 * session as the active session and requests the 工作会话 sub-tab; `failed` /
 * `timeout` arm nothing. Pairs with the pure decisions in
 * `lib/work-session-jump.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { Intent, SessionInfo } from '@ccc/shared/protocol'
import { beginDevLaunch } from '@/lib/dev-launch-view'
import type { PendingWorkSessionSelectRequest } from '@/lib/work-session-jump'
import { WORK_SESSION_JUMP_DELAY_MS } from '@/lib/work-session-jump'
import { installIntentActions } from './intent-actions'
import type { AppCtx } from './types'

const WS = '/ws'

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

function makeCtx(opts: {
  intents?: Intent[]
  sessions?: SessionInfo[]
  workSessions?: SessionInfo[]
  activeKind?: 'work' | 'spec'
}) {
  const enterConsole = vi.fn()
  const selectSession = vi.fn()
  const activeSessionKind = ref<'work' | 'spec'>(opts.activeKind ?? 'work')
  const currentSessions = ref<SessionInfo[]>(opts.sessions ?? [])
  const selectSessionKind = vi.fn((kind: 'work' | 'spec') => {
    activeSessionKind.value = kind
    if (kind === 'work') currentSessions.value = opts.workSessions ?? opts.sessions ?? []
  })
  const refreshSessions = vi.fn()
  const selectWorkSession = vi.fn()
  const showToast = vi.fn()
  const clearDevLaunchTimers = vi.fn()
  const currentWorkspace = ref<string | null>(WS)
  const intents = ref<Record<string, Intent[]>>({ [WS]: opts.intents ?? [] })
  const requestedWorkSessionId = ref<PendingWorkSessionSelectRequest | null>(null)
  const requestedIntentSubTab = ref<'intentSession' | 'specSession' | 'workSession' | null>(null)
  const devLaunch = ref(beginDevLaunch('i-1', 0))
  const devLaunchTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
    jump: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null, jump: null }
  const ctx = {
    send: vi.fn(),
    t: (k: string) => k,
    intentsProject: ref<string | null>(WS),
    selectedIntentSessionId: ref<string | null>(null),
    activeTab: ref('intents'),
    currentWorkspace,
    intents,
    currentIntents: computed(() => intents.value[WS] ?? []),
    currentSessions,
    requestedWorkSessionId,
    requestedIntentSubTab,
    activeSessionKind,
    devLaunch,
    intentPrSync: ref({}),
    devLaunchTimers,
    clearDevLaunchTimers,
    showToast,
    enterConsole,
    selectSessionKind,
    selectSession,
    selectWorkSession,
    refreshSessions,
  } as unknown as AppCtx
  installIntentActions(ctx)
  return {
    ctx,
    enterConsole,
    selectSession,
    selectWorkSession,
    refreshSessions,
    showToast,
    requestedWorkSessionId,
    requestedIntentSubTab,
    activeSessionKind,
    selectSessionKind,
    devLaunchTimers,
    intents,
    currentWorkspace,
    currentSessions,
  }
}

describe('post-Start-Dev jump wiring', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('`ready` close arms a ~1s jump that binds the work session and requests its sub-tab', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')], sessions: [session('dev-1')] })
    // Dwell already elapsed (visibleAt=0) → the ready close resolves immediately.
    h.ctx.dispatchDevLaunch({ kind: 'ready', intentId: 'i-1', now: 1_000 })
    expect(h.selectWorkSession).not.toHaveBeenCalled() // still inside the buffer
    expect(h.requestedIntentSubTab.value).toBeNull()

    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)

    expect(h.selectWorkSession).toHaveBeenCalledWith('dev-1')
    expect(h.requestedIntentSubTab.value).toBe('workSession')
    // Stays on the intents page: no console jump, no session-kind switch, and no
    // pending-select waiting state.
    expect(h.enterConsole).not.toHaveBeenCalled()
    expect(h.selectSessionKind).not.toHaveBeenCalled()
    expect(h.selectSession).not.toHaveBeenCalled()
    expect(h.requestedWorkSessionId.value).toBeNull()
    expect(h.refreshSessions).not.toHaveBeenCalled()
  })

  it('does not arm a jump on `failed`', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')], sessions: [session('dev-1')] })
    h.ctx.dispatchDevLaunch({ kind: 'stage', intentId: 'i-1', stage: 'failed', now: 1_000 })
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)
    expect(h.selectWorkSession).not.toHaveBeenCalled()
    expect(h.requestedIntentSubTab.value).toBeNull()
    expect(h.enterConsole).not.toHaveBeenCalled()
    expect(h.showToast).toHaveBeenCalledWith('intent.devLaunch.failed')
  })

  it('does not arm a jump on `timeout`', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')], sessions: [session('dev-1')] })
    h.ctx.dispatchDevLaunch({ kind: 'timeout', now: 1_000 })
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)
    expect(h.selectWorkSession).not.toHaveBeenCalled()
    expect(h.requestedIntentSubTab.value).toBeNull()
    expect(h.showToast).toHaveBeenCalledWith('intent.devLaunch.timeout')
  })

  it('silently drops the jump when lastWorkSessionId has not landed by the deadline', () => {
    const h = makeCtx({ intents: [intent('i-1', null)], sessions: [] })
    h.ctx.dispatchDevLaunch({ kind: 'ready', intentId: 'i-1', now: 1_000 })
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)

    expect(h.selectWorkSession).not.toHaveBeenCalled()
    expect(h.requestedIntentSubTab.value).toBeNull()
    expect(h.requestedWorkSessionId.value).toBeNull()

    // A later broadcast filling in the id must NOT retro-trigger the jump.
    h.intents.value = { [WS]: [intent('i-1', 'dev-1')] }
    h.currentSessions.value = [session('dev-1')]
    h.ctx.consumePendingWorkSessionSelect(true)
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)
    expect(h.selectWorkSession).not.toHaveBeenCalled()
    expect(h.requestedIntentSubTab.value).toBeNull()
  })

  it('drops the jump when the workspace changed during the buffer', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')], sessions: [session('dev-1')] })
    h.ctx.dispatchDevLaunch({ kind: 'ready', intentId: 'i-1', now: 1_000 })
    h.currentWorkspace.value = '/other'
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)

    expect(h.selectWorkSession).not.toHaveBeenCalled()
    expect(h.requestedIntentSubTab.value).toBeNull()
  })

  it('consumePendingWorkSessionSelect still selects a console-flow target once its row lands', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')], sessions: [] })
    h.requestedWorkSessionId.value = { workspacePath: WS, intentId: 'i-1', sessionId: null }

    // lastWorkSessionId resolved but the row is still missing → refresh, keep waiting.
    h.ctx.consumePendingWorkSessionSelect(true)
    expect(h.selectSession).not.toHaveBeenCalled()
    expect(h.refreshSessions).toHaveBeenCalledWith(WS)
    expect(h.requestedWorkSessionId.value).toEqual({
      workspacePath: WS,
      intentId: 'i-1',
      sessionId: 'dev-1',
    })

    h.currentSessions.value = [session('dev-1')]
    h.ctx.consumePendingWorkSessionSelect()
    expect(h.selectSession).toHaveBeenCalledWith(WS, 'dev-1')
    expect(h.requestedWorkSessionId.value).toBeNull()
  })

  it('consumePendingWorkSessionSelect keeps waiting while the target is absent', () => {
    const h = makeCtx({ sessions: [session('other')] })
    h.requestedWorkSessionId.value = { workspacePath: WS, intentId: 'i-1', sessionId: 'dev-1' }
    h.ctx.consumePendingWorkSessionSelect()
    expect(h.selectSession).not.toHaveBeenCalled()
    expect(h.requestedWorkSessionId.value).toEqual({
      workspacePath: WS,
      intentId: 'i-1',
      sessionId: 'dev-1',
    })
  })
})

describe('setIntentAutomate — todo-only mode switching', () => {
  function withStatus(id: string, status: Intent['status']): Intent {
    return { id, status } as Intent
  }

  it('sends set_intent_automate for a todo intent', () => {
    const h = makeCtx({ intents: [withStatus('i-1', 'todo')] })
    h.ctx.setIntentAutomate('i-1', true)
    expect(h.ctx.send).toHaveBeenCalledWith({
      type: 'set_intent_automate',
      intentId: 'i-1',
      automate: true,
    })
    expect(h.showToast).not.toHaveBeenCalled()
  })

  it('blocks switching for a done intent and surfaces the locked toast', () => {
    const h = makeCtx({ intents: [withStatus('i-1', 'done')] })
    h.ctx.setIntentAutomate('i-1', true)
    expect(h.ctx.send).not.toHaveBeenCalled()
    expect(h.showToast).toHaveBeenCalledWith('intent.automate.locked.toast')
  })

  it('blocks switching for an in_progress intent', () => {
    const h = makeCtx({ intents: [withStatus('i-1', 'in_progress')] })
    h.ctx.setIntentAutomate('i-1', false)
    expect(h.ctx.send).not.toHaveBeenCalled()
    expect(h.showToast).toHaveBeenCalledWith('intent.automate.locked.toast')
  })
})

describe('syncIntentPrStatus', () => {
  it('marks the intent syncing and sends the sync request', () => {
    const h = makeCtx({ intents: [] })

    h.ctx.syncIntentPrStatus('i-1')

    expect(h.ctx.intentPrSync.value['i-1']).toEqual({
      state: 'syncing',
      message: 'intent.prSync.syncing',
    })
    expect(h.ctx.send).toHaveBeenCalledWith({
      type: 'sync_intent_pr_status',
      workspaceId: WS,
      intentId: 'i-1',
    })
  })
})
