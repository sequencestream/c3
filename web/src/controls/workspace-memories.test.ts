/**
 * Control layer for the workspace-setting page's memory tab: the two read/write
 * actions (`installSettingsActions`) and the inbound reply cases
 * (`installMessageHandler`).
 *
 * What is pinned here is the honesty of the delete. The row leaves the list only
 * when the server names the id it removed — never when the click happens, and
 * never on a refusal. A late reply for a workspace the user has left is dropped
 * rather than relabelled, exactly like the observation section beside it.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, WorkspaceMemoryListItem } from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import type { AppCtx } from './types'
import { installSettingsActions } from './settings-actions'
import { installMessageHandler } from './message-handler'

const ITEMS: WorkspaceMemoryListItem[] = [
  { id: 'm-1', title: '提交信息用中文', type: 'preference', status: 'active', updatedAt: 2_000 },
  { id: 'm-2', title: '默认主分支是 main', type: 'fact', status: 'active', updatedAt: 1_000 },
]

function makeCtx(workspace: string | null = 'ws-1') {
  const send = vi.fn()
  const showToast = vi.fn()
  const add = vi.fn()
  const ctx = {
    client: {} as never,
    send,
    add,
    t: (key: string) => key,
    showToast,
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
    parkRecoveryStats: ref(null),
    parkRecoveryError: ref<UiError | null>(null),
    parkRecoveryLoading: ref(false),
    workspaceMemories: ref<WorkspaceMemoryListItem[] | null>(null),
    workspaceMemoriesError: ref<UiError | null>(null),
    workspaceMemoriesLoading: ref(false),
    deletingMemoryIds: ref<string[]>([]),
    // Refs the generic `error` branch walks past on its way to the memory case.
    pendingStandaloneDelivery: ref(null),
    activeDeliverySyncPhase: ref(null),
    activeDeliveryBranchInit: ref(null),
    activeDeliveryPr: ref(null),
    activeDeliveryPrBusy: ref(false),
    createPrProgress: ref(null),
    linkIntentPrPending: ref(false),
    failLinkIntentPr: vi.fn(),
    createIntentPending: ref(false),
    automationSaving: ref(false),
    automationEnabledSaving: ref(false),
    automationSettingBeforeSave: ref(null),
  } as unknown as AppCtx
  installSettingsActions(ctx)
  installMessageHandler(ctx)
  return { ctx, send, showToast }
}

const sentTypes = (send: ReturnType<typeof vi.fn>): string[] =>
  send.mock.calls.map((c) => (c[0] as ClientToServer).type)

describe('loadWorkspaceMemories', () => {
  it('asks for the current workspace listing and marks the tab loading', () => {
    const { ctx, send } = makeCtx()
    ctx.loadWorkspaceMemories()

    expect(send).toHaveBeenCalledWith({ type: 'list_workspace_memories', workspaceName: 'ws-1' })
    expect(ctx.workspaceMemoriesLoading.value).toBe(true)
  })

  it('clears the previous failure as the new request goes out', () => {
    const { ctx } = makeCtx()
    ctx.workspaceMemoriesError.value = { code: 'workspace.unknown' }
    ctx.loadWorkspaceMemories()

    expect(ctx.workspaceMemoriesError.value).toBeNull()
  })

  it('sends nothing when no workspace is selected', () => {
    const { ctx, send } = makeCtx(null)
    ctx.loadWorkspaceMemories()

    expect(send).not.toHaveBeenCalled()
    expect(ctx.workspaceMemoriesLoading.value).toBe(false)
  })
})

describe('workspace_memories reply', () => {
  it('adopts the listing for the workspace on screen', () => {
    const { ctx } = makeCtx()
    ctx.loadWorkspaceMemories()
    ctx.handleMessage({ type: 'workspace_memories', workspaceName: 'ws-1', items: ITEMS })

    expect(ctx.workspaceMemories.value).toEqual(ITEMS)
    expect(ctx.workspaceMemoriesLoading.value).toBe(false)
  })

  it('drops a late answer for a workspace the user has left', () => {
    const { ctx } = makeCtx()
    ctx.loadWorkspaceMemories()
    ctx.handleMessage({ type: 'workspace_memories', workspaceName: 'ws-other', items: ITEMS })

    expect(ctx.workspaceMemories.value).toBeNull()
  })
})

describe('deleteWorkspaceMemory', () => {
  it('sends the soft delete and marks that id in flight, without touching the list', () => {
    const { ctx, send } = makeCtx()
    ctx.workspaceMemories.value = [...ITEMS]
    ctx.deleteWorkspaceMemory('m-1')

    expect(send).toHaveBeenCalledWith({
      type: 'delete_workspace_memory',
      workspaceName: 'ws-1',
      id: 'm-1',
    })
    expect(ctx.deletingMemoryIds.value).toEqual(['m-1'])
    // Not optimistic: the row is still listed until the server confirms.
    expect(ctx.workspaceMemories.value).toHaveLength(2)
  })

  it('does not send the same delete twice while the first is unanswered', () => {
    const { ctx, send } = makeCtx()
    ctx.deleteWorkspaceMemory('m-1')
    ctx.deleteWorkspaceMemory('m-1')

    expect(sentTypes(send)).toEqual(['delete_workspace_memory', 'delete_workspace_memory'])
    expect(ctx.deletingMemoryIds.value).toEqual(['m-1'])
  })
})

describe('workspace_memory_deleted reply', () => {
  it('removes exactly the confirmed row, releases the busy id and names it in a toast', () => {
    const { ctx, showToast } = makeCtx()
    ctx.workspaceMemories.value = [...ITEMS]
    ctx.deleteWorkspaceMemory('m-1')
    ctx.handleMessage({
      type: 'workspace_memory_deleted',
      workspaceName: 'ws-1',
      id: 'm-1',
      title: '提交信息用中文',
    })

    expect(ctx.workspaceMemories.value?.map((m) => m.id)).toEqual(['m-2'])
    expect(ctx.deletingMemoryIds.value).toEqual([])
    expect(showToast).toHaveBeenCalledWith('workspaceSetting.memories.deleted.toast')
  })

  it('ignores a confirmation addressed to another workspace', () => {
    const { ctx } = makeCtx()
    ctx.workspaceMemories.value = [...ITEMS]
    ctx.handleMessage({
      type: 'workspace_memory_deleted',
      workspaceName: 'ws-other',
      id: 'm-1',
      title: '提交信息用中文',
    })

    expect(ctx.workspaceMemories.value).toHaveLength(2)
  })
})

describe('a refused memory operation', () => {
  it('keeps the row, releases the busy id and surfaces the reason as a toast', () => {
    const { ctx, showToast } = makeCtx()
    ctx.workspaceMemories.value = [...ITEMS]
    ctx.deleteWorkspaceMemory('m-1')
    ctx.handleMessage({ type: 'error', error: { code: 'memory.notFound' } })

    expect(ctx.workspaceMemories.value).toHaveLength(2)
    expect(ctx.deletingMemoryIds.value).toEqual([])
    expect(showToast).toHaveBeenCalled()
  })

  it('ends an in-flight listing read on an unresolvable workspace instead of spinning', () => {
    const { ctx } = makeCtx()
    ctx.loadWorkspaceMemories()
    ctx.handleMessage({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: 'x' } },
    })

    expect(ctx.workspaceMemoriesLoading.value).toBe(false)
    expect(ctx.workspaceMemoriesError.value).toEqual({
      code: 'workspace.unknown',
      params: { path: 'x' },
    })
  })
})
