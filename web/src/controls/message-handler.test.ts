import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, computed } from 'vue'
import {
  PENDING_SESSION_PREFIX,
  SYSTEM_AGENT_ID,
  type Discussion,
  type ResearchMessage,
  type GitActionFailureGuidance,
  type ServerToClient,
} from '@ccc/shared/protocol'
import type { SessionInfo } from '@ccc/shared/protocol'
import { installMessageHandler } from './message-handler'
import type { ChatMsg } from '@/lib/chat-types'
import type { AppCtx } from './types'
import { sessionCacheKey, type SessionPageKind } from './state'
import { applyLocale, i18n } from '@/i18n'

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

function error(code: string, requestId?: string, guidance?: unknown): ServerToClient {
  return {
    type: 'error',
    error: { code, params: {}, ...(guidance === undefined ? {} : { guidance }) },
    ...(requestId ? { requestId } : {}),
  } as unknown as ServerToClient
}

function makeCtx() {
  const toast = ref<string | null>(null)
  const intentActionError = ref<string | null>(null)
  const intentActionErrorSeq = ref(0)
  const createIntentPending = ref(false)
  const devLaunch = ref({})
  const specLaunch = ref({})
  const closeDevLaunch = vi.fn()
  const dispatchSpecLaunch = vi.fn()
  const createPrProgress = ref<unknown>(null)
  const dispatchCreatePr = vi.fn()
  const showToast = vi.fn((text: string) => (toast.value = text))
  const intentActionErrorGuidance = ref<GitActionFailureGuidance | null>(null)
  const showIntentActionError = vi.fn(
    (text: string, guidance: GitActionFailureGuidance | null = null) => {
      intentActionError.value = text
      intentActionErrorGuidance.value = guidance
    },
  )
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
  // Read-only observation refs the workspace switch / reconnect paths clear.
  const parkRecoveryStats = ref<import('@ccc/shared/protocol').ParkRecoveryStats | null>(null)
  const parkRecoveryError = ref<import('@ccc/shared/ui-codes').UiError | null>(null)
  const parkRecoveryLoading = ref(false)
  const activeTab = ref<string>('console')
  const savedTab = ref<string>('console')
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
  const onSelectTab = vi.fn((key: string) => {
    activeTab.value = key
    persistViewMode()
  })
  const switchToConsoleTab = vi.fn(() => {
    activeTab.value = 'console'
    persistViewMode()
  })
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
  // `settings` 分支写入的其余快照 refs —— 测试只断言 settingsOpen,其余仅为避免
  // 处理器写入 undefined 而抛错。
  const settingsOpen = ref(false)
  const hostStatus = ref<unknown>(null)
  const vendorRuntime = ref<unknown>(null)
  const sandboxStatus = ref<unknown>(null)
  const bindingStats = ref<unknown>(null)
  const sessionCapabilities = ref<unknown>(null)
  const vendorCapabilities = ref<unknown>(null)
  const vendorModes = ref<unknown>(null)
  const skillSupport = ref<unknown>(null)
  // Delivery branch-init in-flight ref (cleared / advanced by the init frames).
  const activeDeliveryBranchInit = ref<
    import('@/lib/delivery-view').DeliveryBranchInitState | null
  >(null)
  const activeDelivery = ref<import('@ccc/shared/protocol').Delivery | null>(null)
  const activeDeliveryId = ref<string | null>(null)
  const ctx = {
    settingsOpen,
    hostStatus,
    vendorRuntime,
    sandboxStatus,
    bindingStats,
    sessionCapabilities,
    vendorCapabilities,
    vendorModes,
    skillSupport,
    activeDeliveryBranchInit,
    activeDelivery,
    activeDeliveryId,
    toast,
    intentActionError,
    intentActionErrorGuidance,
    intentActionErrorSeq,
    createIntentPending,
    devLaunch,
    specLaunch,
    createPrProgress,
    closeDevLaunch,
    dispatchSpecLaunch,
    dispatchCreatePr,
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
    parkRecoveryStats,
    parkRecoveryError,
    parkRecoveryLoading,
    activeTab,
    savedTab,
    selectedAutomationId,
    serverSettings,
    activeDiscussion,
    activeDiscussionId,
    discussionMessages,
    discussionMaxSeq,
    researchMessages,
    researchMaxSeq,
    persistViewMode,
    onSelectTab,
    switchToConsoleTab,
    pendingDeepLink,
    deepLinkFulfilled,
    deepLinkTimers,
    updateStatus,
    // The handler reads `ctx.t` at install time; a passthrough is enough here.
    t: (key: string) => key,
    add: vi.fn(),
    // Some branches (delivery_transition_failed, delivery_branch_init_result) re-fetch
    // the detail after adopting server truth; a recording stub suffices.
    send: vi.fn(),
    // Post-switch Dashboard refresh hook — a no-op in these session/intent tests.
    maybeRefreshDashboard: vi.fn(),
    personalizedSettings: ref<import('@ccc/shared/protocol').PersonalizedSettings>({
      uiLang: 'en',
    }),
    fetchPersonalizedSettings: vi.fn(),
  } as unknown as AppCtx
  installMessageHandler(ctx)
  return {
    ctx,
    toast,
    updateStatus,
    intentActionError,
    intentActionErrorGuidance,
    intentActionErrorSeq,
    closeDevLaunch,
    dispatchSpecLaunch,
    createPrProgress,
    dispatchCreatePr,
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
    settingsOpen,
    activeTab,
    savedTab,
    persistViewMode,
    onSelectTab,
    switchToConsoleTab,
    activeDeliveryBranchInit,
    activeDelivery,
    activeDeliveryId,
  }
}

describe('personalized settings echo', () => {
  /** Fake browser store so the mirror-to-local step is observable. */
  function installStorage(): Map<string, string> {
    const map = new Map<string, string>()
    ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
    }
    return map
  }

  /** Fake root element so the theme the echo applies is observable. */
  function installDocument(): { dataset: Record<string, string>; style: Record<string, string> } {
    const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> }
    ;(globalThis as unknown as { document: unknown }).document = { documentElement: root }
    return root
  }

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage
    delete (globalThis as unknown as { document?: unknown }).document
    applyLocale('en')
  })

  it('adopts an account echo as the live language and mirrors it into this browser', () => {
    const storage = installStorage()
    const r = makeCtx()
    r.ctx.handleMessage({
      type: 'personalized_settings',
      settings: { uiLang: 'zh' },
      scope: 'account',
    } as ServerToClient)
    expect(i18n.global.locale.value).toBe('zh')
    expect(r.ctx.personalizedSettings.value).toEqual({ uiLang: 'zh', theme: 'dark' })
    // Mirrored so the signed-out state keeps the account's latest choice.
    expect(storage.get('c3.uiLang')).toBe('zh')
  })

  it('adopts an account theme, mirrors it, and puts it on screen right away', () => {
    const storage = installStorage()
    const root = installDocument()
    const r = makeCtx()
    r.ctx.handleMessage({
      type: 'personalized_settings',
      settings: { uiLang: 'en', theme: 'light' },
      scope: 'account',
    } as ServerToClient)
    expect(root.dataset.theme).toBe('light')
    expect(root.style.colorScheme).toBe('light')
    expect(storage.get('c3.theme')).toBe('light')
    expect(r.ctx.personalizedSettings.value).toEqual({ uiLang: 'en', theme: 'light' })
  })

  it('corrects a browser cold-start theme back to the account value on reconnect', () => {
    const storage = installStorage()
    const root = installDocument()
    const r = makeCtx()
    // Cold start showed this browser's light theme; the account says dark.
    root.dataset.theme = 'light'
    storage.set('c3.theme', 'light')
    r.ctx.handleMessage({
      type: 'personalized_settings',
      settings: { uiLang: 'en', theme: 'dark' },
      scope: 'account',
    } as ServerToClient)
    expect(root.dataset.theme).toBe('dark')
    expect(storage.get('c3.theme')).toBe('dark')
  })

  it('normalizes an unknown language in the echo to en', () => {
    installStorage()
    const r = makeCtx()
    r.ctx.handleMessage({
      type: 'personalized_settings',
      settings: { uiLang: 'klingon' },
      scope: 'local',
    } as unknown as ServerToClient)
    expect(r.ctx.personalizedSettings.value).toEqual({ uiLang: 'en', theme: 'dark' })
    expect(i18n.global.locale.value).toBe('en')
  })

  it('normalizes an unknown theme in the echo to dark without touching the language', () => {
    installStorage()
    const root = installDocument()
    const r = makeCtx()
    r.ctx.handleMessage({
      type: 'personalized_settings',
      settings: { uiLang: 'zh', theme: 'solarized' },
      scope: 'local',
    } as unknown as ServerToClient)
    expect(r.ctx.personalizedSettings.value).toEqual({ uiLang: 'zh', theme: 'dark' })
    expect(root.dataset.theme).toBe('dark')
    expect(i18n.global.locale.value).toBe('zh')
  })

  it('never lets a system-settings snapshot change the display language', () => {
    installStorage()
    const r = makeCtx()
    r.ctx.handleMessage({
      type: 'settings',
      // A settings.json written by an older c3 can still carry the removed field.
      settings: { agents: [], defaultAgentId: SYSTEM_AGENT_ID, uiLang: 'zh' },
      hostStatus: [],
      bindingStats: {},
      sessionCapabilities: {},
    } as unknown as ServerToClient)
    expect(i18n.global.locale.value).toBe('en')
  })
})

describe('agent configuration errors', () => {
  it('surfaces an unusable agent group as a global toast and releases the startup overlays', () => {
    // The refusal can come from any creation flow (new session, intent, spec,
    // review), so it belongs to no single page's error channel — and whatever
    // overlay was waiting for the session that will never exist must be released.
    const result = makeCtx()

    result.ctx.handleMessage({
      type: 'error',
      error: { code: 'agent.groupUnavailable', params: { group: '_c3_claude_default' } },
    } as unknown as ServerToClient)

    expect(result.showToast).toHaveBeenCalledOnce()
    expect(result.toast.value).toContain('_c3_claude_default')
    expect(result.showIntentActionError).not.toHaveBeenCalled()
    expect(result.closeDevLaunch).toHaveBeenCalledOnce()
    expect(result.dispatchSpecLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failed' }),
    )
  })
})

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

  it('carries a well-formed Git failure guidance through to the dialog state', () => {
    const result = makeCtx()
    const guidance = {
      reason: 'push_rejected',
      detail: 'git push 失败: ! [rejected]',
      retry: { type: 'intent-action', intentId: 'i-1', action: 'create-pr' },
    }

    result.ctx.handleMessage(error('intent.prCreateFailed', undefined, guidance))

    expect(result.intentActionErrorGuidance.value).toEqual(guidance)
  })

  it('drops a malformed guidance and keeps the plain error', () => {
    // An unknown reason code, an unknown retry action or a missing intent must
    // not become a button the user cannot judge — the dialog falls back to the
    // translated error alone.
    const malformed = [
      {
        reason: 'worktree_exploded',
        detail: 'x',
        retry: { type: 'intent-action', intentId: 'i-1', action: 'create-pr' },
      },
      {
        reason: 'push_rejected',
        detail: 'x',
        retry: { type: 'intent-action', intentId: 'i-1', action: 'delete-worktree' },
      },
      { reason: 'push_rejected', detail: 'x', retry: { type: 'intent-spec', intentId: 'i-1' } },
      { reason: 'push_rejected', detail: 'x' },
      'push_rejected',
    ]
    for (const guidance of malformed) {
      const result = makeCtx()

      result.ctx.handleMessage(error('intent.prCreateFailed', undefined, guidance))

      expect(result.intentActionErrorGuidance.value).toBeNull()
      expect(result.intentActionError.value).not.toBeNull()
    }
  })

  it('leaves the guidance null for a failure that carries none', () => {
    const result = makeCtx()

    result.ctx.handleMessage(error('intent.prCreateNoChanges'))

    expect(result.intentActionError.value).not.toBeNull()
    expect(result.intentActionErrorGuidance.value).toBeNull()
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
    const activeAgentSwitch = ref<import('@ccc/shared/protocol').SessionAgentSwitch | null>(null)
    const currentAgentIndexBySession = ref<Record<string, number>>({})
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
      activeAgentSwitch,
      currentAgentIndexBySession,
      consoleSession,
      activity,
      flags,
      requestedWorkSessionId: ref(null),
      // 活动会话的真实 kind:合并显示分类下,占位行要据此如实声明自己的 kind。
      activeSessionRealKind: ref<import('@ccc/shared/protocol').SessionKind | null>(null),
      pendingDeepLink: ref<import('@/lib/deep-link').DeepLinkTarget | null>(null),
      deepLinkFulfilled: ref<Set<string>>(new Set()),
      deepLinkTimers: { timeout: null as ReturnType<typeof setTimeout> | null },
      send,
      bindConsoleSession,
      clearViewedSession,
      consumePendingWorkSessionSelect,
      maybeRefreshDashboard: vi.fn(),
      personalizedSettings: ref<import('@ccc/shared/protocol').PersonalizedSettings>({
        uiLang: 'en',
      }),
      fetchPersonalizedSettings: vi.fn(),
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

  it('does not duplicate a pending console session as a stale list row', () => {
    const r = makeSessionsCtx()
    const pendingId = `${PENDING_SESSION_PREFIX}new`
    r.currentWorkspace.value = WS
    r.activeSessionKind.value = 'work'
    r.consoleSession.value = { workspacePath: WS, sessionId: pendingId }
    r.activeSession.value = pendingId
    r.activeTitle.value = 'New session'

    r.ctx.handleMessage({
      type: 'sessions',
      workspaceId: WS,
      sessionKind: 'work',
      sessions: [s('history-1', 400)],
      page: { kind: 'first', hasMore: true },
    } as unknown as ServerToClient)

    expect(
      r.sessionsByWorkspace.value[sessionCacheKey(WS, 'work')].map((x) => x.sessionId),
    ).toEqual(['history-1'])
  })

  it('re-keys the console pointer and removes cached pending rows when a session starts', () => {
    const r = makeSessionsCtx()
    const pendingId = `${PENDING_SESSION_PREFIX}new`
    r.activeSession.value = pendingId
    r.consoleSession.value = { workspacePath: WS, sessionId: pendingId }
    r.sessionsByWorkspace.value = {
      [sessionCacheKey(WS, 'work')]: [s('history-1', 400), s(pendingId, 0)],
      [sessionCacheKey(WS, 'spec')]: [s(pendingId, 0), s('spec-1', 300)],
    }

    r.ctx.handleMessage({
      type: 'session_started',
      clientId: pendingId,
      sessionId: 'real-1',
    } as unknown as ServerToClient)

    expect(r.activeSession.value).toBe('real-1')
    expect(r.consoleSession.value).toEqual({ workspacePath: WS, sessionId: 'real-1' })
    expect(Object.values(r.sessionsByWorkspace.value).flat()).not.toContainEqual(
      expect.objectContaining({ sessionId: pendingId }),
    )
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
    const activeTab = ref<string>('intents')
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
    // 活动会话的真实 kind(只读门与溯源都读它);session_selected 每次重算。
    const activeSessionRealKind = ref<import('@ccc/shared/protocol').SessionKind | null>(null)
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
      activeSessionRealKind,
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
      parkRecoveryStats: ref(null),
      parkRecoveryError: ref(null),
      parkRecoveryLoading: ref(false),
      readStoredWorkspace: vi.fn(() => null),
      flushIfReady: vi.fn(),
      notifyAwaitingPermission: vi.fn(),
      send: vi.fn(),
      dispatchSpecLaunch: vi.fn(),
      closeDevLaunch: vi.fn(),
      persistViewMode: vi.fn(),
      devLaunch: ref(null),
      hostStatus: ref<import('@ccc/shared/protocol').VendorHostStatus[]>([]),
      vendorRuntime: ref<Record<string, import('@ccc/shared/protocol').VendorRuntimeStatus> | null>(
        null,
      ),
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
      personalizedSettings: ref<import('@ccc/shared/protocol').PersonalizedSettings>({
        uiLang: 'en',
      }),
      fetchPersonalizedSettings: vi.fn(),
    } as unknown as AppCtx
    installMessageHandler(ctx)
    return {
      ctx,
      activeSessionRealKind,
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

  it('resolves personalized settings for the handshake identity (login seeding path)', () => {
    const r = makeDeepLinkCtx()
    r.ctx.handleMessage({
      type: 'ready',
      workspaces: [] as import('@ccc/shared/protocol').WorkspaceInfo[],
      isAdmin: false,
      subject: 'alice',
      statuses: [],
      updateStatus: { available: false, latestVersion: null, checkedAt: null },
    } as unknown as ServerToClient)
    // A login reconnects, so this is where the account adopts (or seeds) its language.
    expect(r.ctx.fetchPersonalizedSettings).toHaveBeenCalledOnce()
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

  it('session_selected records the session real kind for the read-only gate', () => {
    const r = makeDeepLinkCtx()

    r.ctx.handleMessage({
      type: 'session_selected',
      workspaceId: 'ws1',
      sessionId: 'rev-1',
      title: 'Review',
      mode: 'default',
      history: [],
      status: 'idle',
      vendor: 'claude',
      sessionKind: 'spec_review',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    } as unknown as ServerToClient)

    expect(r.activeSessionRealKind.value).toBe('spec_review')

    // 换成规范撰写会话 → 真实 kind 随之更新(不会残留只读)。
    r.ctx.handleMessage({
      type: 'session_selected',
      workspaceId: 'ws1',
      sessionId: 'spec-1',
      title: 'Spec',
      mode: 'default',
      history: [],
      status: 'idle',
      vendor: 'claude',
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    } as unknown as ServerToClient)

    expect(r.activeSessionRealKind.value).toBe('spec')
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
    expect(r.openIntents).toHaveBeenCalledWith('ws1')
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

// 冷启动引导:首个 settings 快照没有真实 agent 时自动打开系统设置。
function settingsMsg(agentIds: string[]): ServerToClient {
  return {
    type: 'settings',
    settings: { agents: agentIds.map((id) => ({ id, name: id })) },
    hostStatus: [],
    bindingStats: {},
    sessionCapabilities: {},
  } as unknown as ServerToClient
}

describe('auto-open settings when no agent is configured', () => {
  it('opens on a first snapshot with an empty agent list', () => {
    const r = makeCtx()
    r.ctx.handleMessage(settingsMsg([]))
    expect(r.settingsOpen.value).toBe(true)
  })

  it('opens on a first snapshot holding only the system fallback agent', () => {
    const r = makeCtx()
    r.ctx.handleMessage(settingsMsg([SYSTEM_AGENT_ID]))
    expect(r.settingsOpen.value).toBe(true)
  })

  it('stays closed when any non-system agent is present, whatever the ordering', () => {
    const r = makeCtx()
    r.ctx.handleMessage(settingsMsg([SYSTEM_AGENT_ID, 'agent-1']))
    expect(r.settingsOpen.value).toBe(false)

    const r2 = makeCtx()
    r2.ctx.handleMessage(settingsMsg(['agent-1', SYSTEM_AGENT_ID]))
    expect(r2.settingsOpen.value).toBe(false)
  })

  it('does not re-open after the user closes the dialog, even on repeated unconfigured pushes', () => {
    const r = makeCtx()
    r.ctx.handleMessage(settingsMsg([]))
    expect(r.settingsOpen.value).toBe(true)
    // 用户关闭弹窗;随后的重连 / 刷新式重复推送不得再次弹出。
    r.settingsOpen.value = false
    r.ctx.handleMessage(settingsMsg([]))
    r.ctx.handleMessage(settingsMsg([SYSTEM_AGENT_ID]))
    expect(r.settingsOpen.value).toBe(false)
  })

  it('never opens when the first snapshot was configured, even if a later one is not', () => {
    const r = makeCtx()
    r.ctx.handleMessage(settingsMsg(['agent-1']))
    r.ctx.handleMessage(settingsMsg([]))
    expect(r.settingsOpen.value).toBe(false)
  })
})

describe('sessions page setting navigation normalization', () => {
  function installStorage() {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
  }

  it('restores a persisted console only after an enabled authoritative reply', () => {
    installStorage()
    localStorage.setItem('c3.viewMode', 'console')
    const r = makeCtx()
    r.activeTab.value = 'intents'
    r.ctx.handleMessage({
      ...settingsMsg(['agent-1']),
      settings: { showSessionsPage: true, agents: [] },
    } as unknown as ServerToClient)
    expect(r.switchToConsoleTab).toHaveBeenCalledOnce()
  })

  it('disabled reply falls current, persisted, and workcenter-saved console back to intents', () => {
    installStorage()
    localStorage.setItem('c3.viewMode', 'console')
    const r = makeCtx()
    r.ctx.handleMessage({
      ...settingsMsg(['agent-1']),
      settings: { showSessionsPage: false, agents: [] },
    } as unknown as ServerToClient)
    expect(r.onSelectTab).toHaveBeenCalledWith('intents')
    expect(r.activeTab.value).toBe('intents')
    expect(r.savedTab.value).toBe('intents')
    expect(localStorage.getItem('c3.viewMode')).toBe('intents')
  })
})

// 顶部「意图/讨论/自动化」条目角标的入站路径:session_counts 写入响应式状态(带
// workspace 校验),session_status 的运行集合变化触发一次权威计数重取。
describe('session_counts / session_status — 顶部条目角标计数', () => {
  const WS_A = 'ws-a'
  const WS_B = 'ws-b'

  function makeCountsCtx() {
    const currentWorkspace = ref<string | null>(WS_A)
    const sessionCounts = ref<Record<string, number>>({
      work: 0,
      intent: 0,
      spec: 0,
      discussion: 0,
      automation: 0,
      tool: 0,
    })
    const ownerRunningCounts = ref({ intent: 0, discussion: 0, automation: 0 })
    const sessionStatus = ref<Record<string, import('@ccc/shared/protocol').SessionStatus>>({})
    const send = vi.fn()
    const ctx = {
      t: (key: string) => key,
      add: vi.fn(),
      send,
      currentWorkspace,
      sessionCounts,
      ownerRunningCounts,
      sessionStatus,
      activeSession: ref<string | null>(null),
      teamSessions: ref<Set<string>>(new Set()),
      flushIfReady: vi.fn(),
      notifyAwaitingPermission: vi.fn(),
      maybeRefreshDashboard: vi.fn(),
      personalizedSettings: ref<import('@ccc/shared/protocol').PersonalizedSettings>({
        uiLang: 'en',
      }),
      fetchPersonalizedSettings: vi.fn(),
    } as unknown as AppCtx
    installMessageHandler(ctx)
    return { ctx, currentWorkspace, sessionCounts, ownerRunningCounts, send }
  }

  function countsMsg(workspaceId: string, owner: Record<string, number>): ServerToClient {
    return {
      type: 'session_counts',
      workspaceId,
      counts: { work: 1, intent: 0, spec: 0, discussion: 0, automation: 0, tool: 0 },
      ownerCounts: owner,
    } as unknown as ServerToClient
  }

  it('当前 workspace 的响应写入三类条目计数', () => {
    const r = makeCountsCtx()
    r.ctx.handleMessage(countsMsg(WS_A, { intent: 2, discussion: 1, automation: 3 }))
    expect(r.ownerRunningCounts.value).toEqual({ intent: 2, discussion: 1, automation: 3 })
    expect(r.sessionCounts.value.work).toBe(1)
  })

  it('切换 workspace 后到达的旧响应被忽略(计数只反映当前 workspace)', () => {
    const r = makeCountsCtx()
    r.ctx.handleMessage(countsMsg(WS_A, { intent: 2, discussion: 1, automation: 3 }))
    r.currentWorkspace.value = WS_B
    r.ctx.handleMessage(countsMsg(WS_A, { intent: 9, discussion: 9, automation: 9 }))
    expect(r.ownerRunningCounts.value).toEqual({ intent: 2, discussion: 1, automation: 3 })
  })

  it('运行集合从 idle 到 running、再回到 idle 都会重取当前 workspace 的计数', () => {
    const r = makeCountsCtx()
    r.ctx.handleMessage({
      type: 'session_status',
      statuses: [{ sessionId: 's1', status: 'running' }],
    } as unknown as ServerToClient)
    expect(r.send).toHaveBeenCalledWith({ type: 'get_session_counts', workspaceId: WS_A })

    r.send.mockClear()
    r.ctx.handleMessage({
      type: 'session_status',
      statuses: [{ sessionId: 's1', status: 'idle' }],
    } as unknown as ServerToClient)
    expect(r.send).toHaveBeenCalledWith({ type: 'get_session_counts', workspaceId: WS_A })
  })

  it('同一运行快照重播不重复请求;无当前 workspace 时不请求', () => {
    const r = makeCountsCtx()
    const frame = {
      type: 'session_status',
      statuses: [{ sessionId: 's1', status: 'running' }],
    } as unknown as ServerToClient
    r.ctx.handleMessage(frame)
    r.send.mockClear()
    r.ctx.handleMessage(frame)
    expect(r.send).not.toHaveBeenCalled()

    r.currentWorkspace.value = null
    r.ctx.handleMessage({
      type: 'session_status',
      statuses: [{ sessionId: 's2', status: 'running' }],
    } as unknown as ServerToClient)
    expect(r.send).not.toHaveBeenCalled()
  })

  it('刷新回包落地后角标数字随之更新(无需刷新页面)', () => {
    const r = makeCountsCtx()
    r.ctx.handleMessage(countsMsg(WS_A, { intent: 0, discussion: 0, automation: 0 }))
    r.ctx.handleMessage({
      type: 'session_status',
      statuses: [{ sessionId: 's1', status: 'running' }],
    } as unknown as ServerToClient)
    r.ctx.handleMessage(countsMsg(WS_A, { intent: 1, discussion: 0, automation: 0 }))
    expect(r.ownerRunningCounts.value.intent).toBe(1)
  })
})

/**
 * Create-PR overlay routing: every frame is forwarded with the run token the
 * server echoed, so the reducer can tell this run's terminals from an unrelated
 * error or a superseded run's late reply. Routing forwards, matching is the
 * reducer's job (see create-pr-view.test.ts).
 */
describe('create_pr progress routing', () => {
  it('forwards a stage frame with its intent and run token', () => {
    const result = makeCtx()

    result.ctx.handleMessage({
      type: 'create_pr_progress',
      intentId: 'i-1',
      stage: 'pushing',
      requestId: 'r-1',
    } as ServerToClient)

    expect(result.dispatchCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stage',
        intentId: 'i-1',
        stage: 'pushing',
        requestId: 'r-1',
      }),
    )
  })

  it('forwards the success response with its run token', () => {
    const result = makeCtx()

    result.ctx.handleMessage({
      type: 'create_pr_response',
      intentId: 'i-1',
      prId: '42',
      requestId: 'r-1',
    } as ServerToClient)

    expect(result.dispatchCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'done', requestId: 'r-1' }),
    )
  })

  it('forwards an intent-action error with its run token', () => {
    const result = makeCtx()
    result.createPrProgress.value = { intentId: 'i-1' }

    result.ctx.handleMessage(error('intent.prCreateFailed', 'r-1'))

    expect(result.dispatchCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failed', requestId: 'r-1' }),
    )
    // The reason still reaches the user through the existing error dialog.
    expect(result.showIntentActionError).toHaveBeenCalledOnce()
  })

  it('forwards an untagged error without a token so the reducer can drop it', () => {
    const result = makeCtx()
    result.createPrProgress.value = { intentId: 'i-1' }

    // Some other in-flight request failed — a real code, but not this run's.
    result.ctx.handleMessage(error('session.turnRunning'))

    expect(result.dispatchCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failed', requestId: undefined }),
    )
  })

  it('leaves the reducer alone when no overlay is up', () => {
    const result = makeCtx()

    result.ctx.handleMessage(error('intent.prCreateFailed', 'r-1'))

    expect(result.dispatchCreatePr).not.toHaveBeenCalled()
  })
})

describe('delivery branch-init frames', () => {
  it('advances the in-flight phase on progress frames', () => {
    const result = makeCtx()
    result.activeDeliveryBranchInit.value = { deliveryId: 'd1', phase: 'fetching' }

    result.ctx.handleMessage({
      type: 'delivery_branch_init_progress',
      deliveryId: 'd1',
      phase: 'pushing',
    } as ServerToClient)

    expect(result.activeDeliveryBranchInit.value).toEqual({ deliveryId: 'd1', phase: 'pushing' })
  })

  it('ignores a progress frame for a different delivery (superseded retry)', () => {
    const result = makeCtx()
    result.activeDeliveryBranchInit.value = { deliveryId: 'd1', phase: 'fetching' }

    result.ctx.handleMessage({
      type: 'delivery_branch_init_progress',
      deliveryId: 'd2',
      phase: 'binding',
    } as ServerToClient)

    expect(result.activeDeliveryBranchInit.value).toEqual({ deliveryId: 'd1', phase: 'fetching' })
  })

  it('clears the in-flight state, adopts the model and re-fetches the detail on success', () => {
    const result = makeCtx()
    result.activeDeliveryBranchInit.value = { deliveryId: 'd1', phase: 'pushing' }
    result.ctx.handleMessage({
      type: 'delivery_branch_init_result',
      workspaceId: 'w1',
      delivery: {
        id: 'd1',
        workspaceId: 'w1',
        title: 'Sprint 3',
        description: '',
        status: 'planned',
        startDate: null,
        endDate: null,
        branchName: 'delivery/d1-sprint-3',
        baseBranch: 'main',
        branchReady: true,
        integration: { merged: 0, total: 0 },
        createdAt: 1,
        updatedAt: 2,
      },
    } as ServerToClient)

    expect(result.activeDeliveryBranchInit.value).toBeNull()
    expect(result.activeDelivery.value?.branchReady).toBe(true)
    expect(result.activeDelivery.value?.branchName).toBe('delivery/d1-sprint-3')
  })

  it('surfaces the behind-main warning as a toast', () => {
    const result = makeCtx()
    result.ctx.handleMessage({
      type: 'delivery_branch_init_result',
      workspaceId: 'w1',
      warning: 'delivery.branchBehindMain',
      delivery: {
        id: 'd1',
        workspaceId: 'w1',
        title: 'Sprint 3',
        description: '',
        status: 'planned',
        startDate: null,
        endDate: null,
        branchName: 'release/2026-08',
        baseBranch: 'main',
        branchReady: true,
        integration: { merged: 0, total: 0 },
        createdAt: 1,
        updatedAt: 2,
      },
    } as ServerToClient)

    expect(result.showToast).toHaveBeenCalledWith('delivery.warning.branchBehindMain.label')
  })

  it('clears the in-flight state and toasts on an init error code', () => {
    const result = makeCtx()
    result.activeDeliveryBranchInit.value = { deliveryId: 'd1', phase: 'fetching' }

    result.ctx.handleMessage(error('delivery.branchConflict'))

    expect(result.activeDeliveryBranchInit.value).toBeNull()
    expect(result.showToast).toHaveBeenCalled()
  })

  it('leaves the in-flight state alone for a non-init error', () => {
    const result = makeCtx()
    result.activeDeliveryBranchInit.value = { deliveryId: 'd1', phase: 'fetching' }

    result.ctx.handleMessage(error('intent.prCreateFailed'))

    expect(result.activeDeliveryBranchInit.value).toEqual({ deliveryId: 'd1', phase: 'fetching' })
  })
})
