/**
 * openActionTarget — the single dispatcher behind every derived ActionDescriptor.
 * Pins that each wire target type navigates exactly one way.
 */
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { installSettingsActions } from './settings-actions'
import type { AppCtx } from './types'

function makeCtx() {
  const settingsOpen = ref(false)
  const settingsTarget = ref<{ tab: 'agent'; vendor: string; agentId: string } | null>(null)
  const currentWorkspace = ref<string | null>('/ws')
  const workcenterPage = ref<'dashboard' | 'notifications'>('dashboard')
  const requestedIntentId = ref<string | null>(null)
  const requestedIntentSubTab = ref<string | null>(null)
  const requestedWorkcenterEventId = ref<string | null>(null)
  const viewMode = ref<'workspace' | 'workcenter'>('workspace')
  const openIntents = vi.fn()
  const setWorkcenterPage = vi.fn((page: 'dashboard' | 'notifications') => {
    workcenterPage.value = page
  })
  const reloadWorkcenter = vi.fn()
  const send = vi.fn()

  const ctx = {
    send,
    t: (k: string) => k,
    client: {},
    settingsOpen,
    settingsTarget,
    currentWorkspace,
    workcenterPage,
    requestedIntentId,
    requestedIntentSubTab,
    requestedWorkcenterEventId,
    viewMode,
    openIntents,
    setWorkcenterPage,
    reloadWorkcenter,
    personalizedSettingOpen: ref(false),
    personalizedSettings: ref({ uiLang: 'en', theme: 'dark' }),
    workspaceSettingOpen: ref(false),
    installingSkillIds: ref<string[]>([]),
    serverSettings: ref(null),
    skillApprovalRequest: ref(null),
    savedTab: ref('intents'),
    activeTab: ref('intents'),
    flags: { viewModeFirstWorkcenter: false },
    auth: { isAdmin: ref(false) },
    parkRecoveryError: ref(null),
    parkRecoveryLoading: ref(false),
    mcpApiKeyCreated: ref(null),
    showToast: vi.fn(),
    fetchPersonalizedSettings: vi.fn(),
    loadParkRecoveryStats: vi.fn(),
    loadDashboard: vi.fn(),
    persistViewMode: vi.fn(),
    onSelectTab: vi.fn(),
    dismissMcpApiKeyReveal: vi.fn(),
  } as unknown as AppCtx

  installSettingsActions(ctx)
  return {
    ctx,
    settingsOpen,
    settingsTarget,
    viewMode,
    openIntents,
    setWorkcenterPage,
    reloadWorkcenter,
    requestedIntentId,
    requestedIntentSubTab,
    requestedWorkcenterEventId,
    workcenterPage,
    send,
  }
}

describe('openActionTarget', () => {
  it('opens system settings for system-settings-agent', () => {
    const { ctx, settingsOpen, settingsTarget, send } = makeCtx()
    ctx.openActionTarget({
      type: 'system-settings-agent',
      vendor: 'claude',
      agentId: 'a1',
    })
    expect(settingsOpen.value).toBe(true)
    expect(settingsTarget.value).toEqual({ tab: 'agent', vendor: 'claude', agentId: 'a1' })
    expect(send).toHaveBeenCalledWith({ type: 'get_settings' })
  })

  it('selects the intent and requests the spec tab for intent-spec', () => {
    const { ctx, viewMode, openIntents, requestedIntentId, requestedIntentSubTab, settingsOpen } =
      makeCtx()
    ctx.openActionTarget({ type: 'intent-spec', intentId: 'i-1' })
    expect(viewMode.value).toBe('workspace')
    expect(openIntents).toHaveBeenCalledWith('/ws')
    expect(requestedIntentId.value).toBe('i-1')
    expect(requestedIntentSubTab.value).toBe('spec')
    expect(settingsOpen.value).toBe(false)
  })

  it('selects the intent and requests the work-session tab for intent-work-session', () => {
    const {
      ctx,
      viewMode,
      openIntents,
      requestedIntentId,
      requestedIntentSubTab,
      settingsOpen,
      send,
    } = makeCtx()
    ctx.openActionTarget({ type: 'intent-work-session', intentId: 'i-7' })
    expect(viewMode.value).toBe('workspace')
    expect(openIntents).toHaveBeenCalledWith('/ws')
    expect(requestedIntentId.value).toBe('i-7')
    expect(requestedIntentSubTab.value).toBe('workSession')
    expect(settingsOpen.value).toBe(false)
    // Navigation only: nothing is sent, so nothing is resumed, retried or reset.
    expect(send).not.toHaveBeenCalled()
  })

  it('opens workcenter notifications and requests the event for workcenter-event', () => {
    const {
      ctx,
      viewMode,
      setWorkcenterPage,
      reloadWorkcenter,
      requestedWorkcenterEventId,
      workcenterPage,
    } = makeCtx()
    ctx.openActionTarget({ type: 'workcenter-event', eventId: 'e-9' })
    expect(viewMode.value).toBe('workcenter')
    expect(setWorkcenterPage).toHaveBeenCalledWith('notifications')
    expect(workcenterPage.value).toBe('notifications')
    expect(requestedWorkcenterEventId.value).toBe('e-9')
    expect(reloadWorkcenter).toHaveBeenCalledWith('todo')
  })
})
