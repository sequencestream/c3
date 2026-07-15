import { describe, expect, it, vi } from 'vitest'
import { ref, computed } from 'vue'
import type { Discussion, ResearchMessage, ServerToClient } from '@ccc/shared/protocol'
import type { SessionInfo } from '@ccc/shared/protocol'
import { installMessageHandler } from './message-handler'
import type { ChatMsg } from '@/lib/chat-types'
import type { AppCtx } from './types'
import { sessionCacheKey, type SessionPageKind } from './state'

function s(id: string, lastModified: number): SessionInfo {
  return {
    sessionId: id,
    title: id,
    lastModified,
    mode: 'default',
    isToolSession: false,
    vendor: 'claude',
  }
}

function error(code: string): ServerToClient {
  return { type: 'error', error: { code, params: {} } } as unknown as ServerToClient
}

function makeCtx() {
  const toast = ref<string | null>(null)
  const intentActionError = ref<string | null>(null)
  const intentActionErrorSeq = ref(0)
  const devLaunch = ref({})
  const specLaunch = ref({})
  const closeDevLaunch = vi.fn()
  const dispatchSpecLaunch = vi.fn()
  const showToast = vi.fn((text: string) => (toast.value = text))
  const showIntentActionError = vi.fn((text: string) => (intentActionError.value = text))
  const automationSaving = ref(false)
  const automations = ref({})
  const automationsProject = ref<string | null>(null)
  const automationWorkspaceSetting = ref<import('@ccc/shared/protocol').WorkspaceSetting | null>(
    null,
  )
  const automationWorkspaceSettingId = ref<string | null>(null)
  const automationEnabledSaving = ref(false)
  const automationSettingBeforeSave = ref<import('@ccc/shared/protocol').WorkspaceSetting | null>(
    null,
  )
  const currentWorkspaceSetting = ref<import('@ccc/shared/protocol').WorkspaceSetting | null>(null)
  const detectedMainBranch = ref<string | null>(null)
  const resolvedSpecRoot = ref<string | null>(null)
  const sysExtraMounts = ref<import('@ccc/shared/protocol').SysExtraMount[]>([])
  const activeTab = ref<string>('console')
  const selectedAutomationId = ref<string | null>(null)
  // Discussion / research refs touched by discussion_detail + research_message.
  const serverSettings = ref(null)
  const activeDiscussion = ref<Discussion | null>(null)
  const activeDiscussionId = ref<string | null>(null)
  const discussionMessages = ref<ChatMsg[]>([])
  const discussionMaxSeq = ref(0)
  const researchMessages = ref<ChatMsg[]>([])
  const researchMaxSeq = ref(0)
  const persistViewMode = vi.fn()
  // Deep-link refs (destructured by installMessageHandler's ready/session_selected/discussion_detail
  // branches; in tests where they aren't asserted, just prevent TypeError from undefined access).
  const pendingDeepLink = ref<import('@/lib/deep-link').DeepLinkTarget | null>(null)
  const deepLinkFulfilled = ref<Set<string>>(new Set())
  const deepLinkTimers = { timeout: null as ReturnType<typeof setTimeout> | null }
  const updateStatus = ref<import('@ccc/shared/protocol').UpdateStatus>({
    available: false,
    latestVersion: null,
    checkedAt: null,
  })
  const ctx = {
    toast,
    intentActionError,
    intentActionErrorSeq,
    devLaunch,
    specLaunch,
    closeDevLaunch,
    dispatchSpecLaunch,
    showToast,
    showIntentActionError,
    automationSaving,
    automations,
    automationsProject,
    automationWorkspaceSetting,
    automationWorkspaceSettingId,
    automationEnabledSaving,
    automationSettingBeforeSave,
    currentWorkspaceSetting,
    detectedMainBranch,
    resolvedSpecRoot,
    sysExtraMounts,
    activeTab,
    selectedAutomationId,
    serverSettings,
    activeDiscussion,
    activeDiscussionId,
    discussionMessages,
    discussionMaxSeq,
    researchMessages,
    researchMaxSeq,
    persistViewMode,
    pendingDeepLink,
    deepLinkFulfilled,
    deepLinkTimers,
    updateStatus,
    // The handler reads `ctx.t` at install time; a passthrough is enough here.
    t: (key: string) => key,
    add: vi.fn(),
    // Post-switch Dashboard refresh hook — a no-op in these session/intent tests.
    maybeRefreshDashboard: vi.fn(),
  } as unknown as AppCtx
  installMessageHandler(ctx)
  return {
    ctx,
    toast,
    updateStatus,
    intentActionError,
    intentActionErrorSeq,
    closeDevLaunch,
    dispatchSpecLaunch,
    showToast,
    showIntentActionError,
    automationSaving,
    automations,
    automationsProject,
    automationWorkspaceSetting,
    automationWorkspaceSettingId,
    automationEnabledSaving,
    automationSettingBeforeSave,
    researchMessages,
    researchMaxSeq,
  }
}

describe('intent action errors', () => {
  it('uses persistent error-dialog state instead of the toast and releases in-flight UI', () => {
    const result = makeCtx()

    result.ctx.handleMessage(error('intent.specNotWritten'))

    expect(result.intentActionError.value).toBe(
      'The spec has not been written yet; author it before approving.',
    )
    expect(result.toast.value).toBeNull()
    expect(result.showIntentActionError).toHaveBeenCalledOnce()
    expect(result.showToast).not.toHaveBeenCalled()
    expect(result.intentActionErrorSeq.value).toBe(1)
    expect(result.closeDevLaunch).toHaveBeenCalledOnce()
    expect(result.dispatchSpecLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failed' }),
    )
  })

  it('keeps non-intent errors out of the persistent error-dialog state', () => {
    const result = makeCtx()

    result.ctx.handleMessage(error('workspace.unknown'))

    expect(result.intentActionError.value).toBeNull()
    expect(result.showIntentActionError).not.toHaveBeenCalled()
    expect(result.intentActionErrorSeq.value).toBe(0)
  })
})

describe('automation save overlay message handler', () => {
  it('clears automationSaving on automations broadcast', () => {
    const result = makeCtx()
    result.automationSaving.value = true

    result.ctx.handleMessage({
      type: 'automations',
      workspaceId: 'ws1',
      items: [],
    } as unknown as ServerToClient)

    expect(result.automationSaving.value).toBe(false)
  })

  it('clears automationSaving on automation error', () => {
    const result = makeCtx()
    result.automationSaving.value = true

    result.ctx.handleMessage(error('automation.agentRequired'))

    expect(result.automationSaving.value).toBe(false)
  })

  it('clears automationSaving on generic error', () => {
    const result = makeCtx()
    result.automationSaving.value = true

    result.ctx.handleMessage(error('workspace.unknown'))

    expect(result.automationSaving.value).toBe(false)
  })
})

describe('update_status handler (header upgrade hint)', () => {
  it('update_status writes the snapshot into ctx.updateStatus', () => {
    const result = makeCtx()
    result.ctx.handleMessage({
      type: 'update_status',
      updateStatus: { available: true, latestVersion: '2.0.0', checkedAt: 123 },
    } as ServerToClient)
    expect(result.updateStatus.value).toEqual({
      available: true,
      latestVersion: '2.0.0',
      checkedAt: 123,
    })
  })

  it('a later "no update" snapshot overwrites an earlier available one', () => {
    const result = makeCtx()
    result.ctx.handleMessage({
      type: 'update_status',
      updateStatus: { available: true, latestVersion: '2.0.0', checkedAt: 1 },
    } as ServerToClient)
    result.ctx.handleMessage({
      type: 'update_status',
      updateStatus: { available: false, latestVersion: '1.0.0', checkedAt: 2 },
    } as ServerToClient)
    expect(result.updateStatus.value.available).toBe(false)
  })
})

describe('sessions handler — kind-switch pendingConsoleBind', () => {
  const WS = '/ws'

  function makeSessionsCtx() {
    const bindConsoleSession = vi.fn()
    const clearViewedSession = vi.fn()
    const consumePendingWorkSessionSelect = vi.fn()
    const activeSession = ref<string | null>(null)
    const activeWorkspace = ref<string | null>(null)
    const activeTitle = ref('')
    const activeVendor = ref<'claude' | 'codex' | null>(null)
    const activity = ref({ phase: 'idle' } as { phase: string })
    const currentWorkspace = ref<string | null>(null)
    const consoleSession = ref<{ workspacePath: string; sessionId: string } | null>(null)
    const activeSessionKind = ref<SessionPageKind>('work')
    const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
    const sessionPagingByWorkspace = ref<
      Record<
        string,
        { hasMore: boolean; exhausted: boolean; loadingMore: boolean; pendingSince?: number }
      >
    >({})
    const sessionCounts = ref<Record<string, number>>({})
    const activeTab = ref<string>('console')
    const flags = { viewModeFirstWorkcenter: true, pendingConsoleBind: false }
    const send = vi.fn()
    const ctx = {
      toast: ref<string | null>(null),
      intentActionError: ref<string | null>(null),
      intentActionErrorSeq: ref(0),
      devLaunch: ref({}),
      specLaunch: ref({}),
      closeDevLaunch: vi.fn(),
      dispatchSpecLaunch: vi.fn(),
      showToast: vi.fn(),
      showIntentActionError: vi.fn(),
      automationSaving: ref(false),
      automations: ref({}),
      automationsProject: ref<string | null>(null),
      activeTab,
      selectedAutomationId: ref<string | null>(null),
      serverSettings: ref(null),
      activeDiscussion: ref(null),
      activeDiscussionId: ref<string | null>(null),
      discussionMessages: ref<ChatMsg[]>([]),
      discussionMaxSeq: ref(0),
      researchMessages: ref<ChatMsg[]>([]),
      researchMaxSeq: ref(0),
      persistViewMode: vi.fn(),
      t: (key: string) => key,
      add: vi.fn(),
      // Session state
      currentWorkspace,
      sessionsByWorkspace,
      sessionPagingByWorkspace,
      sessionCounts,
      activeSessionKind,
      activeWorkspace,
      activeSession,
      activeTitle,
      activeVendor,
      consoleSession,
      activity,
      flags,
      requestedWorkSessionId: ref(null),
      pendingDeepLink: ref<import('@/lib/deep-link').DeepLinkTarget | null>(null),
      deepLinkFulfilled: ref<Set<string>>(new Set()),
      deepLinkTimers: { timeout: null as ReturnType<typeof setTimeout> | null },
      send,
      bindConsoleSession,
      clearViewedSession,
      consumePendingWorkSessionSelect,
      maybeRefreshDashboard: vi.fn(),
    } as unknown as AppCtx
    installMessageHandler(ctx)
    return {
      ctx,
      bindConsoleSession,
      clearViewedSession,
      consumePendingWorkSessionSelect,
      activeSession,
      activeTitle,
      activeVendor,
      currentWorkspace,
      consoleSession,
      activeSessionKind,
      sessionsByWorkspace,
      flags,
    }
  }

  it('selects the first session after a kind switch when the list is non-empty', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'spec'
    r.flags.pendingConsoleBind = true

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'spec',
      sessions: [s('spec-1', 400)],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).toHaveBeenCalledOnce()
    expect(r.flags.pendingConsoleBind).toBe(false)
  })

  it('keeps right column empty when the new kind list is empty', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'intent'
    r.flags.pendingConsoleBind = true

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'intent',
      sessions: [],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).toHaveBeenCalledOnce()
    expect(r.flags.pendingConsoleBind).toBe(false)
  })

  it('does not consume the flag when sessionKind does not match activeSessionKind', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'spec'
    r.flags.pendingConsoleBind = true

    // List response for 'work' kind arrives while activeSessionKind is 'spec'.
    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('work-1', 400)],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).not.toHaveBeenCalled()
    expect(r.flags.pendingConsoleBind).toBe(true)
  })

  it('does not consume the flag on a live fan-out push', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'work'
    r.flags.pendingConsoleBind = true

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('live-1', 500)],
      page: { kind: 'live', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).not.toHaveBeenCalled()
    expect(r.flags.pendingConsoleBind).toBe(true)
  })

  it('workspace switch still consumes the flag with the sessionKind guard', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'work'
    r.flags.pendingConsoleBind = true

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('work-1', 400)],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(r.bindConsoleSession).toHaveBeenCalledOnce()
    expect(r.flags.pendingConsoleBind).toBe(false)
  })

  it('keeps the pinned console session appended when it is outside the first page', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'spec'
    r.consoleSession.value = { workspacePath: WS, sessionId: 'deep-spec' }
    r.activeSession.value = 'deep-spec'
    r.activeTitle.value = 'Deep Spec'
    r.activeVendor.value = 'codex'

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'spec',
      sessions: [s('homepage-spec', 400)],
      page: { kind: 'first', hasMore: true },
    } as unknown as ServerToClient)

    expect(
      r.sessionsByWorkspace.value[sessionCacheKey(WS, 'spec')].map((x) => x.sessionId),
    ).toEqual(['homepage-spec', 'deep-spec'])
    expect(r.sessionsByWorkspace.value[sessionCacheKey(WS, 'spec')][1]).toMatchObject({
      sessionId: 'deep-spec',
      title: 'Deep Spec',
      vendor: 'codex',
      sessionKind: 'spec',
      ownerKind: 'intent',
      state: 'stale',
    })
  })

  it('does not append the pinned console session to a non-active session kind response', () => {
    const r = makeSessionsCtx()
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'spec'
    r.consoleSession.value = { workspacePath: WS, sessionId: 'deep-spec' }

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('work-1', 400)],
      page: { kind: 'first', hasMore: false },
    } as unknown as ServerToClient)

    expect(
      r.sessionsByWorkspace.value[sessionCacheKey(WS, 'work')].map((x) => x.sessionId),
    ).toEqual(['work-1'])
  })
})

describe('mid-research reconnect (discussion_detail snapshot + live research_message)', () => {
  function detail(researchMessages: ResearchMessage[]): ServerToClient {
    return {
      type: 'discussion_detail',
      discussion: { id: 'd1' } as Discussion,
      messages: [],
      researchMessages,
    } as ServerToClient
  }
  function rmsg(over: Partial<ResearchMessage>): ResearchMessage {
    return { discussionId: 'd1', createdAt: 0, ...over } as ResearchMessage
  }

  it('restores the already-shown research transcript as standard transcript items', () => {
    const r = makeCtx()
    r.ctx.handleMessage(
      detail([
        rmsg({ seq: 1, kind: 'text', text: 'thinking…' }),
        rmsg({ seq: 2, kind: 'tool_use', toolUseId: 'u1', toolName: 'Read', input: { path: 'a' } }),
        rmsg({ seq: 3, kind: 'tool_result', toolUseId: 'u1', content: 'body', isError: false }),
      ]),
    )
    expect(r.researchMessages.value.map((m) => m.kind)).toEqual([
      'assistant',
      'tool-use',
      'tool-result',
    ])
    expect(r.researchMaxSeq.value).toBe(3)
  })

  it('appends a later live research_message and ignores a duplicate/earlier seq', () => {
    const r = makeCtx()
    r.ctx.handleMessage(detail([rmsg({ seq: 1, kind: 'text', text: 'first' })]))
    expect(r.researchMaxSeq.value).toBe(1)

    // Later seq → appended.
    r.ctx.handleMessage({
      type: 'research_message',
      discussionId: 'd1',
      message: rmsg({
        seq: 2,
        kind: 'tool_use',
        toolUseId: 'u9',
        toolName: 'Grep',
        input: { pattern: 'x' },
      }),
    } as ServerToClient)
    expect(r.researchMessages.value.length).toBe(2)
    expect(r.researchMaxSeq.value).toBe(2)

    // Duplicate seq (already shown via snapshot) → ignored.
    r.ctx.handleMessage({
      type: 'research_message',
      discussionId: 'd1',
      message: rmsg({ seq: 2, kind: 'text', text: 'dup' }),
    } as ServerToClient)
    expect(r.researchMessages.value.length).toBe(2)
    expect(r.researchMaxSeq.value).toBe(2)
  })
})

describe('deep link (URL hash routing) — ready branch consumption', () => {
  /** Build a mock ctx with all refs `installMessageHandler` touches in the
   *  ready/session_selected/discussion_detail branches, plus deep-link refs. */
  function makeDeepLinkCtx() {
    const showToast = vi.fn()
    const ensureSessions = vi.fn()
    const selectSession = vi.fn()
    const openIntents = vi.fn()
    const openDiscussions = vi.fn()
    const openDiscussion = vi.fn()
    const maybeRestoreIntents = vi.fn()
    const maybeRestoreDiscussions = vi.fn()
    const maybeRestoreAutomations = vi.fn()
    const maybeRestoreCodes = vi.fn()
    const persistCurrentWorkspace = vi.fn()
    const pendingDeepLink = ref<import('@/lib/deep-link').DeepLinkTarget | null>(null)
    const deepLinkFulfilled = ref<Set<string>>(new Set())
    const deepLinkTimers = { timeout: null as ReturnType<typeof setTimeout> | null }
    const currentWorkspace = ref<string | null>(null)
    const activeTab = ref<string>('console')
    const sessionStatus = ref<Record<string, import('@ccc/shared/protocol').SessionStatus>>({})
    const specLaunch = ref<import('@/lib/spec-launch-view').SpecLaunchModel | null>(null)
    const workspaces = ref<import('@ccc/shared/protocol').WorkspaceInfo[]>([])

    // Refs needed by session_selected handler
    const activeWorkspace = ref<string | null>(null)
    const activeSession = ref<string | null>(null)
    const activeTitle = ref('')
    const activeVendor = ref<'claude' | 'codex' | null>(null)
    const activeAgentSwitch = ref<import('@ccc/shared/protocol').SessionAgentSwitch | null>(null)
    const activeSessionSource = ref<import('@/lib/session-jump').SessionSourceAction | null>(null)
    const mode = ref<import('@ccc/shared/protocol').ModeToken>('default')
    const codexPolicy = ref<import('@ccc/shared/protocol').CodexPolicy | null>(null)
    const consoleSession = ref<import('@/lib/tab-view').SessionRef | null>(null)
    const messages = ref<import('@/lib/chat-types').ChatMsg[]>([])
    const counters = { nextId: 1, nextQueueId: 1 }
    const availableCommands = ref<import('@ccc/shared/protocol').SlashCommandInfo[]>([])
    const activity = ref<import('@/lib/chat-types').RunActivity>({ phase: 'idle' })
    const taskModel = ref<import('@/lib/task-list').TaskListModel>({
      tasks: [],
    })
    const selectedIntentSessionId = ref<string | null>(null)
    const teamSessions = ref<Set<string>>(new Set())
    const serverSettings = ref<import('@ccc/shared/protocol').SystemSettings | null>(null)
    const currentAgentIndexBySession = ref<Record<string, number>>({})
    const sideEffectPendingBySession = ref<Record<string, boolean>>({})
    const clearSideEffectPending = vi.fn()
    const intentsProject = ref<string | null>(null)
    const requestedIntentId = ref<string | null>(null)
    const requestedWorkSessionId = ref<
      import('@/lib/work-session-jump').PendingWorkSessionSelectRequest | null
    >(null)

    // Refs needed by discussion_detail handler
    const discussions = ref<Record<string, import('@ccc/shared/protocol').Discussion[]>>({})
    const activeDiscussion = ref<import('@ccc/shared/protocol').Discussion | null>(null)
    const activeDiscussionId = ref<string | null>(null)
    const discussionMessages = ref<import('@/lib/chat-types').ChatMsg[]>([])
    const discussionMaxSeq = ref(0)
    const researchMessages = ref<import('@/lib/chat-types').ChatMsg[]>([])
    const researchMaxSeq = ref(0)
    const discussionDispatch = ref<Record<string, import('@/lib/discussion-view').DispatchView>>({})
    const discussionRunState = ref<Record<string, 'running' | 'paused'>>({})
    const researchState = ref<Record<string, 'running'>>({})
    const automationsProject = ref<string | null>(null)
    const automations = ref<Record<string, import('@ccc/shared/protocol').Automation[]>>({})
    const selectedAutomationId = ref<string | null>(null)
    const automationSaving = ref(false)
    const automationLogs = ref<
      Record<string, import('@ccc/shared/protocol').AutomationExecutionLog[]>
    >({})
    const executionTranscripts = ref<
      Record<string, import('@ccc/shared/protocol').TranscriptItem[]>
    >({})
    const automationToolManifest = ref<
      Record<string, import('@ccc/shared/protocol').ToolManifestEntry[] | null>
    >({})
    const automationToolManifestLoading = ref(false)
    const automationToolManifestError = ref<string | null>(null)
    const codesProject = ref<string | null>(null)
    const codesDirs = ref<Record<string, import('@ccc/shared/protocol').CodeDirEntry[]>>({})
    const codesLoadingDirs = ref<Set<string>>(new Set())
    const codesTabs = ref<import('@/lib/codes-view').CodeTab[]>([])
    const codesSearchResult = ref<import('@/lib/codes-view').CodesSearchResultView | null>(null)
    const codesSearchLoading = ref(false)
    const codesSearchMode = ref<import('@ccc/shared/protocol').CodeSearchMode>('filename')
    const codesActivePath = ref<string | null>(null)
    const codesExpanded = ref<Set<string>>(new Set())
    const codesSearchQuery = ref('')
    const codesSearchPattern = ref('*')
    const intentActionErrorSeq = ref(0)
    const workcenterEvents = ref<import('@ccc/shared/protocol').WaitUserInvolveEvent[]>([])
    const notificationPermission = ref('default')

    // Refs needed by applyStatuses
    const sessionCounts = ref<Record<string, number>>({})
    const sessionsByWorkspace = ref<Record<string, import('@ccc/shared/protocol').SessionInfo[]>>(
      {},
    )
    const sessionPagingByWorkspace = ref<
      Record<
        string,
        { hasMore: boolean; exhausted: boolean; loadingMore: boolean; pendingSince?: number }
      >
    >({})
    const activeSessionKind = ref<import('./state').SessionPageKind>('work')
    const flags = { viewModeFirstWorkcenter: true, pendingConsoleBind: false }

    const ctx = {
      t: (key: string) => key,
      add: vi.fn(),
      showToast,
      ensureSessions,
      selectSession,
      openIntents,
      openDiscussions,
      openDiscussion,
      maybeRestoreIntents,
      maybeRestoreDiscussions,
      maybeRestoreAutomations,
      maybeRestoreCodes,
      persistCurrentWorkspace,
      pendingDeepLink,
      deepLinkFulfilled,
      deepLinkTimers,
      currentWorkspace,
      activeTab,
      sessionStatus,
      specLaunch,
      activeWorkspace,
      activeSession,
      activeTitle,
      activeVendor,
      activeAgentSwitch,
      activeSessionSource,
      mode,
      codexPolicy,
      consoleSession,
      messages,
      counters,
      availableCommands,
      activity,
      taskModel,
      selectedIntentSessionId,
      teamSessions,
      serverSettings,
      currentAgentIndexBySession,
      sideEffectPendingBySession,
      clearSideEffectPending,
      intentsProject,
      requestedIntentId,
      requestedWorkSessionId,
      discussions,
      activeDiscussion,
      activeDiscussionId,
      discussionMessages,
      discussionMaxSeq,
      researchMessages,
      researchMaxSeq,
      discussionDispatch,
      discussionRunState,
      researchState,
      automationsProject,
      automations,
      selectedAutomationId,
      automationSaving,
      automationLogs,
      executionTranscripts,
      automationToolManifest,
      automationToolManifestLoading,
      automationToolManifestError,
      codesProject,
      codesDirs,
      codesLoadingDirs,
      codesTabs,
      codesSearchResult,
      codesSearchLoading,
      codesSearchMode,
      codesActivePath,
      codesExpanded,
      codesSearchQuery,
      codesSearchPattern,
      intentActionErrorSeq,
      workcenterEvents,
      notificationPermission,
      sessionCounts,
      sessionsByWorkspace,
      sessionPagingByWorkspace,
      activeSessionKind,
      flags,
      workspaces,
      clearPendingDeepLink: (): void => {
        pendingDeepLink.value = null
        if (deepLinkTimers.timeout) clearTimeout(deepLinkTimers.timeout)
        deepLinkTimers.timeout = null
      },
      authStatus: ref('unknown'),
      auth: {
        setIsAdmin: vi.fn(),
        setSubject: vi.fn(),
        handleLoginResult: vi.fn(),
        handleUnauthenticated: vi.fn(),
        currentToken: undefined,
        bindSender: vi.fn(),
        status: ref('unknown'),
      },
      workspaceSettingOpen: ref(false),
      currentWorkspaceSetting: ref(null),
      detectedMainBranch: ref(null),
      resolvedSpecRoot: ref(null),
      sysExtraMounts: ref([]),
      readStoredWorkspace: vi.fn(() => null),
      flushIfReady: vi.fn(),
      notifyAwaitingPermission: vi.fn(),
      send: vi.fn(),
      dispatchSpecLaunch: vi.fn(),
      closeDevLaunch: vi.fn(),
      persistViewMode: vi.fn(),
      devLaunch: ref(null),
      hostStatus: ref<import('@ccc/shared/protocol').VendorHostStatus[]>([]),
      bindingStats: ref<import('@ccc/shared/protocol').SessionBindingStats | null>(null),
      sessionCapabilities: ref<Record<
        string,
        import('@ccc/shared/protocol').SessionCapabilities
      > | null>(null),
      vendorCapabilities: ref<Record<string, Record<string, boolean>> | null>(null),
      vendorModes: ref<Record<string, import('@ccc/shared/protocol').VendorModeCatalog> | null>(
        null,
      ),
      skillSupport: ref<Record<string, import('@ccc/shared/protocol').SkillSupportState> | null>(
        null,
      ),
      skillLinkStatuses: ref<import('@ccc/shared/protocol').SkillLinkStatus[]>([]),
      installingSkillIds: ref<string[]>([]),
      skillApprovalRequest: ref<
        import('@/components/SkillApprovalModal/SkillApprovalModal.vue').ApprovalRequest | null
      >(null),
      updateStatus: ref<import('@ccc/shared/protocol').UpdateStatus>({
        available: false,
        latestVersion: null,
        checkedAt: null,
      }),
      workcenterHasMore: ref(false),
      workcenterLoading: ref(false),
      workcenterAppendNext: ref(false),
      intentPrSync: ref<
        Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
      >({}),
      automation: ref<Record<string, import('@ccc/shared/protocol').WorkflowStatus>>({}),
      intentSessions: ref<Record<string, import('@ccc/shared/protocol').IntentSessionInfo[]>>({}),
      intentSessionRunStates: ref<Record<string, 'running'>>({}),
      intentSpecContent: ref<string | null>(null),
      intentSpecLoading: ref(false),
      pendingSpecRel: ref<string | null>(null),
      automationTimezone: ref('UTC'),
      newSessionOpen: ref(false),
      newSessionWorkspace: ref<string | null>(null),
      currentSessions: computed(() => []),
      requestedIntentSubTab: ref(null),
      requestedMergedTab: ref(null),
      requestedIntentSessionId: ref(null),
      toast: ref<string | null>(null),
      intentActionError: ref<string | null>(null),
      maybeRefreshDashboard: vi.fn(),
    } as unknown as AppCtx
    installMessageHandler(ctx)
    return {
      ctx,
      showToast,
      ensureSessions,
      selectSession,
      openIntents,
      openDiscussions,
      openDiscussion,
      maybeRestoreIntents,
      maybeRestoreDiscussions,
      maybeRestoreAutomations,
      maybeRestoreCodes,
      persistCurrentWorkspace,
      pendingDeepLink,
      currentWorkspace,
      activeTab,
      deepLinkFulfilled,
      activeWorkspace,
      activeSession,
    }
  }

  it('ready seeds updateStatus from the handshake snapshot', () => {
    const r = makeDeepLinkCtx()
    r.ctx.handleMessage({
      type: 'ready',
      workspaces: [] as import('@ccc/shared/protocol').WorkspaceInfo[],
      isAdmin: true,
      subject: null,
      statuses: [],
      updateStatus: { available: true, latestVersion: '3.1.4', checkedAt: 99 },
    } as unknown as ServerToClient)
    expect(r.ctx.updateStatus.value).toEqual({
      available: true,
      latestVersion: '3.1.4',
      checkedAt: 99,
    })
  })

  it('consumes a session deep link with valid workspace → dispatches selectSession + skips maybeRestore*', () => {
    const r = makeDeepLinkCtx()
    r.pendingDeepLink.value = { kind: 'session', workspaceId: 'ws1', id: 'sess-abc' }

    r.ctx.handleMessage({
      type: 'ready',
      workspaces: [{ id: 'ws1' }] as import('@ccc/shared/protocol').WorkspaceInfo[],
      isAdmin: true,
      subject: null,
      statuses: [],
      updateStatus: { available: false, latestVersion: null, checkedAt: null },
    } as unknown as ServerToClient)

    expect(r.currentWorkspace.value).toBe('ws1')
    expect(r.selectSession).toHaveBeenCalledWith('ws1', 'sess-abc')
    // pending deep link is NOT cleared yet — it stays for fulfillment tracking
    expect(r.pendingDeepLink.value).toEqual({ kind: 'session', workspaceId: 'ws1', id: 'sess-abc' })
    // maybeRestore* should NOT be called when deep link is consumed
    expect(r.maybeRestoreIntents).not.toHaveBeenCalled()
    expect(r.maybeRestoreDiscussions).not.toHaveBeenCalled()
    expect(r.maybeRestoreAutomations).not.toHaveBeenCalled()
    expect(r.maybeRestoreCodes).not.toHaveBeenCalled()
    expect(r.showToast).not.toHaveBeenCalled()
  })

  it('consumes an intent deep link with valid workspace → dispatches openIntents + skipped maybeRestore*', () => {
    const r = makeDeepLinkCtx()
    r.pendingDeepLink.value = { kind: 'intent', workspaceId: 'ws1', id: 'int-xyz' }

    r.ctx.handleMessage({
      type: 'ready',
      workspaces: [{ id: 'ws1' }] as import('@ccc/shared/protocol').WorkspaceInfo[],
      isAdmin: true,
      subject: null,
      statuses: [],
    } as unknown as ServerToClient)

    expect(r.currentWorkspace.value).toBe('ws1')
    expect(r.openIntents).toHaveBeenCalledWith('ws1')
    expect(r.maybeRestoreIntents).not.toHaveBeenCalled()
    expect(r.showToast).not.toHaveBeenCalled()
  })

  it('consumes a discussion deep link with valid workspace → dispatches openDiscussions + openDiscussion + skipped maybeRestore*', () => {
    const r = makeDeepLinkCtx()
    r.pendingDeepLink.value = { kind: 'discussion', workspaceId: 'ws1', id: 'disc-456' }

    r.ctx.handleMessage({
      type: 'ready',
      workspaces: [{ id: 'ws1' }] as import('@ccc/shared/protocol').WorkspaceInfo[],
      isAdmin: true,
      subject: null,
      statuses: [],
    } as unknown as ServerToClient)

    expect(r.currentWorkspace.value).toBe('ws1')
    expect(r.openDiscussions).toHaveBeenCalledWith('ws1')
    expect(r.openDiscussion).toHaveBeenCalledWith('disc-456')
    expect(r.maybeRestoreDiscussions).not.toHaveBeenCalled()
    expect(r.showToast).not.toHaveBeenCalled()
  })

  it('workspace not found → shows toast, clears pending, falls through to maybeRestore*', () => {
    const r = makeDeepLinkCtx()
    r.pendingDeepLink.value = { kind: 'session', workspaceId: 'ws-unknown', id: 'sess-abc' }

    r.ctx.handleMessage({
      type: 'ready',
      workspaces: [{ id: 'ws1' }] as import('@ccc/shared/protocol').WorkspaceInfo[],
      isAdmin: true,
      subject: null,
      statuses: [],
    } as unknown as ServerToClient)

    expect(r.showToast).toHaveBeenCalledWith('deepLink.notFound')
    expect(r.pendingDeepLink.value).toBeNull()
    // Falls through to normal restore
    expect(r.maybeRestoreIntents).toHaveBeenCalled()
    expect(r.maybeRestoreDiscussions).toHaveBeenCalled()
    expect(r.selectSession).not.toHaveBeenCalled()
  })

  it('session_selected fulfills a session deep link', () => {
    const r = makeDeepLinkCtx()
    r.pendingDeepLink.value = { kind: 'session', workspaceId: 'ws1', id: 'sess-target' }
    r.activeWorkspace.value = 'ws1'
    r.activeSession.value = 'sess-target'

    r.ctx.handleMessage({
      type: 'session_selected',
      workspaceId: 'ws1',
      sessionId: 'sess-target',
      title: 'Target Session',
      mode: 'default',
      history: [],
      status: 'idle',
      vendor: 'claude',
    } as unknown as ServerToClient)

    expect(r.pendingDeepLink.value).toBeNull()
    expect(r.deepLinkFulfilled.value.has('sess-target')).toBe(true)
  })

  it('discussion_detail fulfills a discussion deep link', () => {
    const r = makeDeepLinkCtx()
    r.pendingDeepLink.value = { kind: 'discussion', workspaceId: 'ws1', id: 'disc-target' }

    r.ctx.handleMessage({
      type: 'discussion_detail',
      discussion: { id: 'disc-target' } as import('@ccc/shared/protocol').Discussion,
      messages: [],
      researchMessages: [],
    } as unknown as ServerToClient)

    expect(r.pendingDeepLink.value).toBeNull()
    expect(r.deepLinkFulfilled.value.has('disc-target')).toBe(true)
  })

  it('no pending deep link → normal restore path', () => {
    const r = makeDeepLinkCtx()

    r.ctx.handleMessage({
      type: 'ready',
      workspaces: [{ id: 'ws1' }] as import('@ccc/shared/protocol').WorkspaceInfo[],
      isAdmin: true,
      subject: null,
      statuses: [],
    } as unknown as ServerToClient)

    expect(r.maybeRestoreIntents).toHaveBeenCalled()
    expect(r.maybeRestoreDiscussions).toHaveBeenCalled()
    expect(r.maybeRestoreAutomations).toHaveBeenCalled()
    expect(r.maybeRestoreCodes).toHaveBeenCalled()
    expect(r.selectSession).not.toHaveBeenCalled()
    expect(r.showToast).not.toHaveBeenCalled()
  })
})

describe('automation workspace-gate snapshot (workspace_setting routing)', () => {
  function gateSetting(
    automationEnabled: boolean,
  ): import('@ccc/shared/protocol').WorkspaceSetting {
    return {
      forge: 'auto',
      defaultMode: {} as import('@ccc/shared/protocol').WorkspaceSetting['defaultMode'],
      gitBranchMode: 'current-branch',
      sddEnabled: false,
      automationEnabled,
    } as import('@ccc/shared/protocol').WorkspaceSetting
  }

  function wsSetting(workspaceId: string, automationEnabled: boolean): ServerToClient {
    return {
      type: 'workspace_setting',
      workspaceId,
      config: gateSetting(automationEnabled),
    } as unknown as ServerToClient
  }

  it('adopts a reply whose workspace matches the current automations project', () => {
    const r = makeCtx()
    r.automationsProject.value = 'ws1'
    r.ctx.handleMessage(wsSetting('ws1', false))
    expect(r.automationWorkspaceSettingId.value).toBe('ws1')
    expect(r.automationWorkspaceSetting.value?.automationEnabled).toBe(false)
  })

  it('ignores a late reply for a previous workspace (isolation)', () => {
    const r = makeCtx()
    r.automationsProject.value = 'ws2'
    // A stale reply for the workspace we just navigated away from must not leak in.
    r.ctx.handleMessage(wsSetting('ws1', false))
    expect(r.automationWorkspaceSetting.value).toBeNull()
    expect(r.automationWorkspaceSettingId.value).toBeNull()
  })

  it('a matching echo clears the pending-save flag and rollback snapshot', () => {
    const r = makeCtx()
    r.automationsProject.value = 'ws1'
    r.automationEnabledSaving.value = true
    r.automationSettingBeforeSave.value = gateSetting(true)
    r.ctx.handleMessage(wsSetting('ws1', false))
    expect(r.automationEnabledSaving.value).toBe(false)
    expect(r.automationSettingBeforeSave.value).toBeNull()
    expect(r.automationWorkspaceSetting.value?.automationEnabled).toBe(false)
  })

  it('a server error while saving rolls the gate back to the last confirmed value', () => {
    const r = makeCtx()
    r.automationsProject.value = 'ws1'
    // Pending save: optimistic value is false; last confirmed was true.
    r.automationEnabledSaving.value = true
    r.automationWorkspaceSetting.value = gateSetting(false)
    r.automationSettingBeforeSave.value = gateSetting(true)
    r.ctx.handleMessage(error('workspaceSetting.invalidDefaultMode'))
    expect(r.automationEnabledSaving.value).toBe(false)
    expect(r.automationSettingBeforeSave.value).toBeNull()
    expect(r.automationWorkspaceSetting.value?.automationEnabled).toBe(true)
  })
})
