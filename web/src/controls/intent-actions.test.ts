/**
 * Control-layer wiring for the post-Start-Dev jump: a `ready` close arms a ~1s
 * delayed jump that flips to the console tab and selects the intent's new work
 * session; `failed` / `timeout` arm nothing. Pairs with the pure decisions in
 * `lib/work-session-jump.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { Intent, SessionInfo } from '@ccc/shared/protocol'
import { beginDevLaunch } from '@/lib/dev-launch-view'
import { WORK_SESSION_JUMP_DELAY_MS } from '@/lib/work-session-jump'
import { installIntentActions } from './intent-actions'
import type { AppCtx } from './types'

const WS = '/ws'

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

function makeCtx(opts: { intents?: Intent[]; sessions?: SessionInfo[] }) {
  const enterConsole = vi.fn()
  const selectSession = vi.fn()
  const refreshSessions = vi.fn()
  const showToast = vi.fn()
  const clearDevLaunchTimers = vi.fn()
  const currentWorkspace = ref<string | null>(WS)
  const intents = ref<Record<string, Intent[]>>({ [WS]: opts.intents ?? [] })
  const currentSessions = ref<SessionInfo[]>(opts.sessions ?? [])
  const requestedWorkSessionId = ref<string | null>(null)
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
    devLaunch,
    devLaunchTimers,
    clearDevLaunchTimers,
    showToast,
    enterConsole,
    selectSession,
    refreshSessions,
  } as unknown as AppCtx
  installIntentActions(ctx)
  return {
    ctx,
    enterConsole,
    selectSession,
    refreshSessions,
    showToast,
    requestedWorkSessionId,
    devLaunchTimers,
    currentSessions,
  }
}

describe('post-Start-Dev jump wiring', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('`ready` close arms a ~1s jump that selects the already-loaded target session', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')], sessions: [session('dev-1')] })
    // Dwell already elapsed (visibleAt=0) → the ready close resolves immediately.
    h.ctx.dispatchDevLaunch({ kind: 'ready', intentId: 'i-1', now: 1_000 })
    expect(h.selectSession).not.toHaveBeenCalled() // still inside the buffer
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)
    expect(h.enterConsole).toHaveBeenCalledOnce()
    expect(h.selectSession).toHaveBeenCalledWith(WS, 'dev-1')
    expect(h.requestedWorkSessionId.value).toBeNull()
  })

  it('stages a one-shot request + refresh when the target has not yet landed, then applies it', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')], sessions: [] })
    h.ctx.dispatchDevLaunch({ kind: 'ready', intentId: 'i-1', now: 1_000 })
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)
    expect(h.selectSession).not.toHaveBeenCalled()
    expect(h.requestedWorkSessionId.value).toBe('dev-1')
    expect(h.refreshSessions).toHaveBeenCalledWith(WS)
    // The session lands; consumption selects it and clears the one-shot request.
    h.currentSessions.value = [session('dev-1')]
    h.ctx.consumePendingWorkSessionSelect()
    expect(h.selectSession).toHaveBeenCalledWith(WS, 'dev-1')
    expect(h.requestedWorkSessionId.value).toBeNull()
  })

  it('does not arm a jump on `failed`', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')], sessions: [session('dev-1')] })
    h.ctx.dispatchDevLaunch({ kind: 'stage', intentId: 'i-1', stage: 'failed', now: 1_000 })
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)
    expect(h.selectSession).not.toHaveBeenCalled()
    expect(h.enterConsole).not.toHaveBeenCalled()
    expect(h.showToast).toHaveBeenCalledWith('intent.devLaunch.failed')
  })

  it('does not arm a jump when the intent has no dev session id', () => {
    const h = makeCtx({ intents: [intent('i-1', null)], sessions: [] })
    h.ctx.dispatchDevLaunch({ kind: 'ready', intentId: 'i-1', now: 1_000 })
    vi.advanceTimersByTime(WORK_SESSION_JUMP_DELAY_MS)
    expect(h.selectSession).not.toHaveBeenCalled()
    expect(h.requestedWorkSessionId.value).toBeNull()
  })

  it('consumePendingWorkSessionSelect keeps waiting while the target is absent', () => {
    const h = makeCtx({ sessions: [session('other')] })
    h.requestedWorkSessionId.value = 'dev-1'
    h.ctx.consumePendingWorkSessionSelect()
    expect(h.selectSession).not.toHaveBeenCalled()
    expect(h.requestedWorkSessionId.value).toBe('dev-1')
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
