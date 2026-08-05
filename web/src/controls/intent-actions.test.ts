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
import {
  CREATE_PR_MIN_DWELL_MS,
  CREATE_PR_SAFETY_TIMEOUT_MS,
  type CreatePrModel,
} from '@/lib/create-pr-view'
import { beginDevLaunch, DEV_LAUNCH_SAFETY_TIMEOUT_MS } from '@/lib/dev-launch-view'
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
  const createPrProgress = ref<CreatePrModel | null>(null)
  const createPrTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null }
  const clearCreatePrTimers = vi.fn(() => {
    if (createPrTimers.dwell) clearTimeout(createPrTimers.dwell)
    if (createPrTimers.safety) clearTimeout(createPrTimers.safety)
    createPrTimers.dwell = null
    createPrTimers.safety = null
  })
  const devLaunchTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
    jump: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null, jump: null }
  const ctx = {
    send: vi.fn(),
    t: (k: string) => k,
    persistViewMode: vi.fn(),
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
    createPrProgress,
    createPrTimers,
    clearCreatePrTimers,
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
    createPrProgress,
    createPrTimers,
    clearCreatePrTimers,
    intents,
    currentWorkspace,
    currentSessions,
  }
}

describe('intent view loading', () => {
  it('loads the workspace setting with the intent sessions', () => {
    const h = makeCtx({})

    h.ctx.openIntents(WS)

    expect(h.ctx.send).toHaveBeenCalledWith({
      type: 'load_workspace_setting',
      workspaceId: WS,
    })
    expect(h.ctx.send).toHaveBeenCalledWith({ type: 'open_intent_session', workspaceId: WS })
    expect(h.ctx.send).toHaveBeenCalledWith({ type: 'list_intent_sessions', workspaceId: WS })
  })
})

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
    // The safety timeout only closes once the ceiling elapses (startedAt=0).
    h.ctx.dispatchDevLaunch({ kind: 'timeout', now: DEV_LAUNCH_SAFETY_TIMEOUT_MS })
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

/**
 * Create-PR overlay wiring, from the click onwards: one request, an overlay that
 * blocks immediately and lights the server's stages, and closure on every
 * terminal — response, action error, or the safety timeout (which is the only
 * one that needs a hint, since it says nothing about the server's outcome).
 */
describe('createPr — progress overlay wiring', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Click 创建 PR and let the minimum dwell elapse so terminals resolve at once. */
  function clickAndDwell(h: ReturnType<typeof makeCtx>) {
    h.ctx.createPr('i-1')
    vi.advanceTimersByTime(CREATE_PR_MIN_DWELL_MS)
  }

  /** The token of the run the overlay is currently tracking. */
  function runToken(h: ReturnType<typeof makeCtx>): string | undefined {
    return h.createPrProgress.value?.requestId
  }

  it('sends create_pr once with a run token and shows the overlay on the first step', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })

    h.ctx.createPr('i-1')

    expect(h.ctx.send).toHaveBeenCalledTimes(1)
    expect(h.ctx.send).toHaveBeenCalledWith({
      type: 'create_pr',
      workspaceId: WS,
      intentId: 'i-1',
      requestId: expect.any(String),
    })
    expect(h.createPrProgress.value).toMatchObject({ intentId: 'i-1', phase: 'analyzing-changes' })
    // The overlay tracks exactly the token that went out on the wire.
    expect(runToken(h)).toBe(
      (h.ctx.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.requestId,
    )
    expect(h.createPrTimers.safety).not.toBeNull()
  })

  it('lights each stage the server reports and ignores another intent’s frames', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })
    h.ctx.createPr('i-1')
    const requestId = runToken(h)

    for (const stage of ['committing', 'pushing', 'creating-pr'] as const) {
      h.ctx.dispatchCreatePr({ kind: 'stage', intentId: 'i-1', stage, requestId, now: 10 })
      expect(h.createPrProgress.value?.phase).toBe(stage)
    }
    h.ctx.dispatchCreatePr({
      kind: 'stage',
      intentId: 'other',
      stage: 'committing',
      requestId,
      now: 20,
    })
    expect(h.createPrProgress.value?.phase).toBe('creating-pr')
  })

  it('closes silently on the success response', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })
    clickAndDwell(h)

    h.ctx.dispatchCreatePr({ kind: 'done', requestId: runToken(h), now: Date.now() })

    expect(h.createPrProgress.value).toBeNull()
    expect(h.clearCreatePrTimers).toHaveBeenCalled()
    expect(h.createPrTimers.safety).toBeNull()
    expect(h.showToast).not.toHaveBeenCalled()
  })

  it('closes on a failure without a toast — the error dialog explains it', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })
    clickAndDwell(h)

    h.ctx.dispatchCreatePr({ kind: 'failed', requestId: runToken(h), now: Date.now() })

    expect(h.createPrProgress.value).toBeNull()
    expect(h.createPrTimers.safety).toBeNull()
    expect(h.showToast).not.toHaveBeenCalled()
  })

  it('stays up when an unrelated request fails while creating', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })
    clickAndDwell(h)

    // An error frame from some other in-flight request: no run token, not ours.
    h.ctx.dispatchCreatePr({ kind: 'failed', now: Date.now() })

    expect(h.createPrProgress.value).toMatchObject({ intentId: 'i-1' })
    expect(h.createPrTimers.safety).not.toBeNull()
  })

  it('ignores a superseded run’s late terminal after the user retried', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })
    h.ctx.createPr('i-1')
    const firstRun = runToken(h)

    // Nothing came back in time: the overlay is released, the server task lives on.
    vi.advanceTimersByTime(CREATE_PR_SAFETY_TIMEOUT_MS)
    expect(h.createPrProgress.value).toBeNull()

    // The user clicks again, and only then does the first run reply.
    h.ctx.createPr('i-1')
    vi.advanceTimersByTime(CREATE_PR_MIN_DWELL_MS)
    expect(runToken(h)).not.toBe(firstRun)

    h.ctx.dispatchCreatePr({ kind: 'done', requestId: firstRun, now: Date.now() })

    expect(h.createPrProgress.value).toMatchObject({ intentId: 'i-1' })
    expect(h.createPrTimers.safety).not.toBeNull()
  })

  it('holds a fast terminal for the minimum dwell, then closes via its timer', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })
    h.ctx.createPr('i-1')

    h.ctx.dispatchCreatePr({ kind: 'done', requestId: runToken(h), now: Date.now() })
    expect(h.createPrProgress.value).toMatchObject({ pendingCloseReason: 'done' })

    vi.advanceTimersByTime(CREATE_PR_MIN_DWELL_MS)
    expect(h.createPrProgress.value).toBeNull()
  })

  it('releases the overlay with a hint when no terminal ever arrives', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })
    h.ctx.createPr('i-1')

    vi.advanceTimersByTime(CREATE_PR_SAFETY_TIMEOUT_MS)

    expect(h.createPrProgress.value).toBeNull()
    expect(h.showToast).toHaveBeenCalledWith('intent.createPrProgress.timeout')
  })

  it('starts a clean overlay for a later run', () => {
    const h = makeCtx({ intents: [intent('i-1', 'dev-1')] })
    clickAndDwell(h)
    const firstRun = runToken(h)
    h.ctx.dispatchCreatePr({ kind: 'failed', requestId: firstRun, now: Date.now() })

    h.ctx.createPr('i-2')

    expect(h.createPrProgress.value).toMatchObject({ intentId: 'i-2', phase: 'analyzing-changes' })
    expect(h.createPrProgress.value?.pendingCloseReason).toBeUndefined()
    // A fresh token, so the previous run's frames cannot reach this overlay.
    expect(runToken(h)).not.toBe(firstRun)
  })
})

/**
 * The retry a failure dialog offers. The point of the assertions is that a retry
 * is a NEW attempt through the ORIGINAL entry point — same message, same token
 * discipline, same overlay — and never a second, gate-free channel.
 */
describe('retryIntentAction — re-enters the original entry point', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('re-runs start_development exactly once, overlay and all', () => {
    const h = makeCtx({ intents: [intent('i-1', null)] })

    h.ctx.retryIntentAction({
      reason: 'worktree_branch_or_path_taken',
      detail: "fatal: 'x' already exists",
      retry: { type: 'intent-action', intentId: 'i-1', action: 'start-development' },
    })

    expect(h.ctx.send).toHaveBeenCalledTimes(1)
    expect(h.ctx.send).toHaveBeenCalledWith({
      type: 'start_development',
      workspaceId: WS,
      intentId: 'i-1',
    })
    // The same startup overlay the button arms — a retry is not a silent re-send.
    expect(h.ctx.devLaunch.value).toMatchObject({ intentId: 'i-1' })
  })

  it('re-runs create_pr exactly once, with a fresh run token and overlay', () => {
    const h = makeCtx({ intents: [intent('i-2', 'dev-2')] })

    h.ctx.retryIntentAction({
      reason: 'push_rejected',
      detail: 'git push 失败: ! [rejected]',
      retry: { type: 'intent-action', intentId: 'i-2', action: 'create-pr' },
    })

    expect(h.ctx.send).toHaveBeenCalledTimes(1)
    expect(h.ctx.send).toHaveBeenCalledWith({
      type: 'create_pr',
      workspaceId: WS,
      intentId: 'i-2',
      requestId: expect.any(String),
    })
    expect(h.createPrProgress.value).toMatchObject({ intentId: 'i-2', phase: 'analyzing-changes' })
  })

  it('retries an unknown reason the same way — the reason steers nothing', () => {
    const h = makeCtx({ intents: [intent('i-3', 'dev-3')] })

    h.ctx.retryIntentAction({
      reason: 'unknown',
      detail: '',
      retry: { type: 'intent-action', intentId: 'i-3', action: 'create-pr' },
    })

    expect(h.ctx.send).toHaveBeenCalledTimes(1)
    expect(h.ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'create_pr', intentId: 'i-3' }),
    )
  })
})
