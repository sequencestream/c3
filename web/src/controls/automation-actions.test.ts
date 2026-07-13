// @vitest-environment happy-dom
/**
 * Live-refresh wiring for the selected, running automation execution: the control
 * layer starts a 5s poll (detail + transcript) while a running llm execution is
 * selected on the active, visible page, and stops it after one final transcript
 * fetch on completion. The decision logic itself is unit-tested in
 * `lib/automation-refresh.test.ts`; this verifies the timer/visibility wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import type {
  ClientToServer,
  CreateAutomationInput,
  Automation,
  AutomationExecutionLog,
} from '@ccc/shared/protocol'
import { installAutomationActions } from './automation-actions'
import type { AppCtx } from './types'

const TICK = 5_000

function runningLog(): AutomationExecutionLog {
  return {
    id: 'e1',
    automationId: 's1',
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    output: '',
    error: null,
    status: 'running',
    sessionId: 'sess1',
  }
}

function doneLog(): AutomationExecutionLog {
  return { ...runningLog(), finishedAt: 1000, exitCode: 0, status: 'success' }
}

const llmAutomation = { id: 's1', type: 'llm' } as unknown as Automation
const commandAutomation = { id: 's1', type: 'command' } as unknown as Automation

let visibility = 'visible'

function setVisible(state: 'visible' | 'hidden'): void {
  visibility = state
}

function makeCtx() {
  const send = vi.fn<(msg: ClientToServer) => void>()
  const activeTab = ref<string>('console')
  const selectedAutomationId = ref<string | null>(null)
  const selectedExecutionId = ref<string | null>(null)
  const selectedAutomation = ref<Automation | null>(null)
  const selectedExecution = ref<AutomationExecutionLog | null>(null)
  const automationSaving = ref(false)
  const automationsProject = ref<string | null>(null)
  const automationWorkspaceSetting = ref<import('@ccc/shared/protocol').WorkspaceSetting | null>(
    null,
  )
  const automationWorkspaceSettingId = ref<string | null>(null)
  const automationEnabledSaving = ref(false)
  const automationSettingBeforeSave = ref<import('@ccc/shared/protocol').WorkspaceSetting | null>(
    null,
  )
  const persistViewMode = vi.fn()
  const showToast = vi.fn()
  const t = vi.fn((key: string) => key)
  const serverSettings = ref({
    agents: [
      { id: 'claude-1', vendor: 'claude', enabled: true, displayName: 'Claude', orderSeq: 0 },
    ],
  })
  const ctx = {
    send,
    client: {} as unknown as AppCtx['client'],
    activeTab,
    automationsProject,
    automationWorkspaceSetting,
    automationWorkspaceSettingId,
    automationEnabledSaving,
    automationSettingBeforeSave,
    persistViewMode,
    selectedAutomationId,
    selectedExecutionId,
    selectedAutomation,
    selectedExecution,
    automationSaving,
    automationFormOpen: ref(false),
    automationFormTarget: ref(null),
    automationToolManifest: ref({}),
    automationToolManifestLoading: ref(false),
    automationToolManifestError: ref(null),
    showToast,
    t,
    serverSettings,
  } as unknown as AppCtx
  installAutomationActions(ctx)
  return {
    send,
    activeTab,
    selectedAutomationId,
    selectedExecutionId,
    selectedAutomation,
    selectedExecution,
    automationSaving,
    showToast,
    t,
    serverSettings,
    ctx,
    automationsProject,
    automationWorkspaceSetting,
    automationWorkspaceSettingId,
    automationEnabledSaving,
    automationSettingBeforeSave,
  }
}

// Select a running llm execution on the active automations page.
async function selectRunning(c: ReturnType<typeof makeCtx>): Promise<void> {
  c.selectedAutomationId.value = 's1'
  c.selectedExecutionId.value = 'e1'
  c.selectedAutomation.value = llmAutomation
  c.activeTab.value = 'automations'
  c.selectedExecution.value = runningLog()
  await nextTick()
}

function transcriptCalls(send: ReturnType<typeof vi.fn>): unknown[] {
  return send.mock.calls.filter((c) => (c[0] as ClientToServer).type === 'get_execution_transcript')
}
function detailCalls(send: ReturnType<typeof vi.fn>): unknown[] {
  return send.mock.calls.filter((c) => (c[0] as ClientToServer).type === 'get_automation_detail')
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('running execution live refresh', () => {
  it('polls detail + transcript every tick while running and visible (AC#1)', async () => {
    const c = makeCtx()
    await selectRunning(c)
    c.send.mockClear()

    vi.advanceTimersByTime(TICK)
    expect(detailCalls(c.send)).toHaveLength(1)
    expect(transcriptCalls(c.send)).toHaveLength(1)

    vi.advanceTimersByTime(TICK)
    expect(detailCalls(c.send)).toHaveLength(2)
    expect(transcriptCalls(c.send)).toHaveLength(2)
  })

  it('stops polling and fetches the transcript once on completion (AC#2)', async () => {
    const c = makeCtx()
    await selectRunning(c)
    vi.advanceTimersByTime(TICK)
    c.send.mockClear()

    // Execution reaches a terminal state (automation_detail refresh would do this).
    c.selectedExecution.value = doneLog()
    await nextTick()

    // Exactly one final transcript fetch, no further detail poll.
    expect(transcriptCalls(c.send)).toHaveLength(1)
    expect(detailCalls(c.send)).toHaveLength(0)

    // No more periodic sends after completion.
    c.send.mockClear()
    vi.advanceTimersByTime(TICK * 3)
    expect(c.send).not.toHaveBeenCalled()
  })

  it('never polls when the selected execution is already terminal (AC#3)', async () => {
    const c = makeCtx()
    c.selectedAutomationId.value = 's1'
    c.selectedExecutionId.value = 'e1'
    c.selectedAutomation.value = llmAutomation
    c.activeTab.value = 'automations'
    c.selectedExecution.value = doneLog()
    await nextTick()
    c.send.mockClear()

    vi.advanceTimersByTime(TICK * 3)
    expect(c.send).not.toHaveBeenCalled()
  })

  it('never polls a non-llm (command) running execution (AC#5)', async () => {
    const c = makeCtx()
    c.selectedAutomationId.value = 's1'
    c.selectedExecutionId.value = 'e1'
    c.selectedAutomation.value = commandAutomation
    c.activeTab.value = 'automations'
    c.selectedExecution.value = runningLog()
    await nextTick()
    c.send.mockClear()

    vi.advanceTimersByTime(TICK * 3)
    expect(c.send).not.toHaveBeenCalled()
  })

  it('skips the tick while hidden and resumes when visible again (AC#4)', async () => {
    const c = makeCtx()
    await selectRunning(c)
    c.send.mockClear()

    setVisible('hidden')
    vi.advanceTimersByTime(TICK * 2)
    expect(c.send).not.toHaveBeenCalled()

    setVisible('visible')
    vi.advanceTimersByTime(TICK)
    expect(detailCalls(c.send)).toHaveLength(1)
    expect(transcriptCalls(c.send)).toHaveLength(1)
  })

  it('stops polling when leaving the automations tab', async () => {
    const c = makeCtx()
    await selectRunning(c)
    c.activeTab.value = 'console'
    await nextTick()
    c.send.mockClear()

    vi.advanceTimersByTime(TICK * 3)
    expect(c.send).not.toHaveBeenCalled()
  })
})

describe('automation save overlay', () => {
  it('sets automationSaving on create and sends the message', () => {
    const c = makeCtx()
    const input: CreateAutomationInput = {
      type: 'command',
      config: {},
      workspaceId: 'ws1',
      vendor: 'claude',
      agentId: null,
      triggerType: 'cron',
      cronExpression: '*/30 * * * *',
      mode: 'default',
    }
    c.ctx.createAutomation(input)
    expect(c.automationSaving.value).toBe(true)
    expect(c.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'create_automation',
        workspaceId: 'ws1',
        input,
      }),
    )
  })

  it('sets automationSaving on create from template and sends the message', () => {
    const c = makeCtx()
    c.automationsProject.value = 'ws1'
    c.ctx.createAutomationFromTemplate('pr-status-poller')
    expect(c.automationSaving.value).toBe(true)
    expect(c.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'create_automation' }))
  })

  it('sets automationSaving on update and sends the message', () => {
    const c = makeCtx()
    c.ctx.updateAutomation('s1', { status: 'active' })
    expect(c.automationSaving.value).toBe(true)
    expect(c.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'update_automation',
        automationId: 's1',
        input: { status: 'active' },
      }),
    )
  })

  it('does not set automationSaving when template has no agent', () => {
    const c = makeCtx()
    c.automationsProject.value = 'ws1'
    c.serverSettings.value = { agents: [] }
    c.ctx.createAutomationFromTemplate('pr-status-poller')
    expect(c.automationSaving.value).toBe(false)
    expect(c.send).not.toHaveBeenCalled()
    expect(c.showToast).toHaveBeenCalledOnce()
  })

  it('importAutomations dispatches one create per input and toasts a summary', () => {
    const c = makeCtx()
    const inputs = [
      {
        type: 'command',
        config: { command: 'a' },
        workspaceId: 'ws1',
        cronExpression: '* * * * *',
        mode: 'read-only',
        vendor: 'claude',
        initialStatus: 'paused',
      },
      {
        type: 'command',
        config: { command: 'b' },
        workspaceId: 'ws1',
        cronExpression: '* * * * *',
        mode: 'read-only',
        vendor: 'claude',
        initialStatus: 'paused',
      },
    ] as never
    c.ctx.importAutomations(inputs)
    const creates = c.send.mock.calls.filter(([m]) => m.type === 'create_automation')
    expect(creates).toHaveLength(2)
    expect(c.showToast).toHaveBeenCalledWith('automation.importExport.import.summary')
  })

  it('importAutomations is a no-op for an empty list', () => {
    const c = makeCtx()
    c.ctx.importAutomations([])
    expect(c.send).not.toHaveBeenCalled()
    expect(c.showToast).not.toHaveBeenCalled()
  })
})

describe('openAutomations — loads the workspace gate setting', () => {
  it('sends load_workspace_setting and resets the gate snapshot for the new workspace', () => {
    const c = makeCtx()
    c.automationWorkspaceSetting.value = {
      automationEnabled: false,
    } as import('@ccc/shared/protocol').WorkspaceSetting
    c.automationWorkspaceSettingId.value = 'old-ws'
    c.automationEnabledSaving.value = true

    c.ctx.openAutomations('ws1')

    expect(
      c.send.mock.calls.some(
        (call) =>
          (call[0] as ClientToServer).type === 'load_workspace_setting' &&
          (call[0] as { workspaceId: string }).workspaceId === 'ws1',
      ),
    ).toBe(true)
    // The prior workspace's snapshot is cleared so the toggle never shows it.
    expect(c.automationWorkspaceSetting.value).toBeNull()
    expect(c.automationWorkspaceSettingId.value).toBeNull()
    expect(c.automationEnabledSaving.value).toBe(false)
  })
})

describe('setAutomationEnabled — workspace gate save', () => {
  function seed(c: ReturnType<typeof makeCtx>, enabled: boolean): void {
    c.automationsProject.value = 'ws1'
    c.automationWorkspaceSettingId.value = 'ws1'
    c.automationWorkspaceSetting.value = {
      forge: 'auto',
      devSkill: '/keep-me',
      automationEnabled: enabled,
    } as import('@ccc/shared/protocol').WorkspaceSetting
  }

  it('saves the full snapshot with only automationEnabled replaced, optimistic + saving flag', () => {
    const c = makeCtx()
    seed(c, true)

    c.ctx.setAutomationEnabled(false)

    const saveCall = c.send.mock.calls.find(
      (call) => (call[0] as ClientToServer).type === 'save_workspace_setting',
    )
    expect(saveCall).toBeDefined()
    const payload = saveCall![0] as {
      workspaceId: string
      config: import('@ccc/shared/protocol').WorkspaceSetting
    }
    expect(payload.workspaceId).toBe('ws1')
    expect(payload.config.automationEnabled).toBe(false)
    // Sibling settings are preserved (full snapshot, not a gate-only object).
    expect(payload.config.devSkill).toBe('/keep-me')
    // Optimistic local flip + pending-save flag + rollback capture.
    expect(c.automationWorkspaceSetting.value?.automationEnabled).toBe(false)
    expect(c.automationEnabledSaving.value).toBe(true)
    expect(c.automationSettingBeforeSave.value?.automationEnabled).toBe(true)
  })

  it('ignores a save when the snapshot belongs to a different workspace', () => {
    const c = makeCtx()
    seed(c, true)
    c.automationWorkspaceSettingId.value = 'other-ws' // stale snapshot

    c.ctx.setAutomationEnabled(false)

    expect(
      c.send.mock.calls.some(
        (call) => (call[0] as ClientToServer).type === 'save_workspace_setting',
      ),
    ).toBe(false)
  })

  it('is a no-op when the target value equals the current gate', () => {
    const c = makeCtx()
    seed(c, true)

    c.ctx.setAutomationEnabled(true)

    expect(
      c.send.mock.calls.some(
        (call) => (call[0] as ClientToServer).type === 'save_workspace_setting',
      ),
    ).toBe(false)
    expect(c.automationEnabledSaving.value).toBe(false)
  })

  it('rolls back and toasts when there is no live connection', () => {
    const c = makeCtx()
    seed(c, true)
    ;(c.ctx as { client: unknown }).client = null

    c.ctx.setAutomationEnabled(false)

    // Restored to the last confirmed value; flag cleared; failure surfaced.
    expect(c.automationWorkspaceSetting.value?.automationEnabled).toBe(true)
    expect(c.automationEnabledSaving.value).toBe(false)
    expect(c.automationSettingBeforeSave.value).toBeNull()
    expect(c.showToast).toHaveBeenCalledWith('automation.list.gate.saveFailed')
  })
})
