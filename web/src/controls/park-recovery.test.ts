/**
 * Control layer for the workspace-setting page's local observation section: the
 * read action (`installSettingsActions`) and the inbound reply case
 * (`installMessageHandler`).
 *
 * The two properties worth pinning: the numbers never enter the settings save
 * path, and a reply is adopted only for the workspace still on screen — a late
 * answer for one the user has left must be dropped rather than relabelled.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, ParkRecoveryStats } from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import type { AppCtx } from './types'
import { installSettingsActions } from './settings-actions'
import { installMessageHandler } from './message-handler'

const STATS: ParkRecoveryStats = {
  windowMs: 86_400_000,
  eligible: 8,
  recovered: 5,
  pending: 2,
  rate: 0.625,
}

function makeCtx(workspace: string | null = 'ws-1') {
  const send = vi.fn()
  const ctx = {
    client: {} as never,
    send,
    t: (key: string) => key,
    showToast: vi.fn(),
    settingsOpen: ref(false),
    personalizedSettingOpen: ref(false),
    personalizedSettings: ref({}),
    workspaceSettingOpen: ref(false),
    currentWorkspace: ref<string | null>(workspace),
    currentWorkspaceSetting: ref(null),
    installingSkillIds: ref<string[]>([]),
    serverSettings: ref(null),
    skillApprovalRequest: ref(null),
    viewMode: ref<'workspace' | 'workcenter'>('workspace'),
    savedTab: ref('intents'),
    activeTab: ref('intents'),
    flags: {},
    parkRecoveryStats: ref<ParkRecoveryStats | null>(null),
    parkRecoveryError: ref<UiError | null>(null),
    parkRecoveryLoading: ref(false),
  } as unknown as AppCtx
  installSettingsActions(ctx)
  installMessageHandler(ctx)
  return { ctx, send }
}

const sentTypes = (send: ReturnType<typeof vi.fn>): string[] =>
  send.mock.calls.map((c) => (c[0] as ClientToServer).type)

describe('loadParkRecoveryStats', () => {
  it('requests the current workspace figures and marks the section loading', () => {
    const { ctx, send } = makeCtx()
    ctx.loadParkRecoveryStats()

    expect(ctx.parkRecoveryLoading.value).toBe(true)
    expect(send).toHaveBeenCalledWith({ type: 'get_park_recovery_stats', workspaceName: 'ws-1' })
  })

  it('clears a previous failure as the retry goes out', () => {
    const { ctx } = makeCtx()
    ctx.parkRecoveryError.value = { code: 'intent.parkStatsUnavailable' }
    ctx.loadParkRecoveryStats()

    expect(ctx.parkRecoveryError.value).toBe(null)
  })

  it('sends nothing without a current workspace', () => {
    const { ctx, send } = makeCtx(null)
    ctx.loadParkRecoveryStats()

    expect(send).not.toHaveBeenCalled()
    expect(ctx.parkRecoveryLoading.value).toBe(false)
  })
})

describe('openWorkspaceSetting', () => {
  it('fetches the observation alongside the setting and the key roster, as separate reads', () => {
    const { ctx, send } = makeCtx()
    ctx.openWorkspaceSetting()

    expect(sentTypes(send)).toEqual([
      'load_workspace_setting',
      'list_mcp_api_keys',
      'get_park_recovery_stats',
    ])
  })
})

describe('park_recovery_stats reply', () => {
  it('adopts the figures for the workspace on screen', () => {
    const { ctx } = makeCtx()
    ctx.loadParkRecoveryStats()
    ctx.handleMessage({ type: 'park_recovery_stats', workspaceName: 'ws-1', stats: STATS })

    expect(ctx.parkRecoveryStats.value).toEqual(STATS)
    expect(ctx.parkRecoveryError.value).toBe(null)
    expect(ctx.parkRecoveryLoading.value).toBe(false)
  })

  it('drops a late reply for a workspace the user has left', () => {
    const { ctx } = makeCtx()
    ctx.handleMessage({ type: 'park_recovery_stats', workspaceName: 'ws-other', stats: STATS })

    expect(ctx.parkRecoveryStats.value).toBe(null)
  })

  it('keeps a failure a failure instead of an empty measurement', () => {
    const { ctx } = makeCtx()
    ctx.handleMessage({
      type: 'park_recovery_stats',
      workspaceName: 'ws-1',
      error: { code: 'intent.parkStatsUnavailable' },
    })

    expect(ctx.parkRecoveryStats.value).toBe(null)
    expect(ctx.parkRecoveryError.value).toEqual({ code: 'intent.parkStatsUnavailable' })
  })

  it('replaces a stale failure when a later read succeeds', () => {
    const { ctx } = makeCtx()
    ctx.handleMessage({
      type: 'park_recovery_stats',
      workspaceName: 'ws-1',
      error: { code: 'intent.parkStatsUnavailable' },
    })
    ctx.handleMessage({ type: 'park_recovery_stats', workspaceName: 'ws-1', stats: STATS })

    expect(ctx.parkRecoveryError.value).toBe(null)
    expect(ctx.parkRecoveryStats.value).toEqual(STATS)
  })
})
