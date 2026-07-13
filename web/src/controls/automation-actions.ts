import { computed, getCurrentInstance, onUnmounted, watch } from 'vue'
import type {
  CreateAutomationInput,
  Automation,
  UpdateAutomationInput,
  VendorId,
} from '@ccc/shared/protocol'
import {
  AUTOMATION_REFRESH_INTERVAL_MS,
  decideAutomationRefresh,
  isExecutionRunning,
} from '@/lib/automation-refresh'
import type { AppCtx } from './types'
import { findEnabledVendorAgent, getAutomationTemplate } from '@/pages/automations/templates'

// Install automation-tab actions (read path + create/edit form) onto the ctx.
export function installAutomationActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    activeTab,
    automationsProject,
    selectedAutomationId,
    selectedExecutionId,
    selectedAutomation,
    selectedExecution,
    automationSaving,
    automationFormOpen,
    automationFormTarget,
    automationToolManifest,
    automationToolManifestLoading,
    automationToolManifestError,
  } = ctx

  // Enter the automations view for a project: fetch its list and reset the right pane.
  ctx.openAutomations = (path: string): void => {
    ctx.activeTab.value = 'automations'
    automationsProject.value = path
    selectedAutomationId.value = null
    // Reset the workspace-gate snapshot; the `load_workspace_setting` reply below
    // reseeds it for THIS workspace, so the toggle never shows a prior workspace's
    // value while the fresh setting is in flight.
    ctx.automationWorkspaceSetting.value = null
    ctx.automationWorkspaceSettingId.value = null
    ctx.automationEnabledSaving.value = false
    ctx.automationSettingBeforeSave.value = null
    ctx.persistViewMode()
    send({ type: 'list_automations', workspaceId: path })
    // Load the workspace setting alongside the list so the automation gate toggle
    // reflects the persisted `automationEnabled`.
    send({ type: 'load_workspace_setting', workspaceId: path })
    // Pull settings so the next-run preview uses the configured `timezone`.
    send({ type: 'get_settings' })
  }

  // Flip the workspace-level automation gate. Saves the full server-echoed snapshot
  // with only `automationEnabled` replaced (sibling settings preserved), optimistically
  // flips locally, and lets the server `workspace_setting` echo reconcile the final
  // value. Guards against a stale/cross-workspace snapshot and a lost connection.
  ctx.setAutomationEnabled = (enabled: boolean): void => {
    const path = automationsProject.value
    const base = ctx.automationWorkspaceSetting.value
    if (!path || !base || ctx.automationWorkspaceSettingId.value !== path) return
    if (ctx.automationEnabledSaving.value) return
    if ((base.automationEnabled ?? true) === enabled) return
    // Capture the pre-flip snapshot so an error reply can roll the toggle back.
    ctx.automationSettingBeforeSave.value = base
    const next = { ...base, automationEnabled: enabled }
    ctx.automationWorkspaceSetting.value = next
    ctx.automationEnabledSaving.value = true
    try {
      if (!ctx.client) throw new Error('no connection')
      send({ type: 'save_workspace_setting', workspaceId: path, config: next })
    } catch {
      // Lost connection before the send landed — restore and surface the failure.
      ctx.automationWorkspaceSetting.value = ctx.automationSettingBeforeSave.value
      ctx.automationSettingBeforeSave.value = null
      ctx.automationEnabledSaving.value = false
      ctx.showToast(ctx.t('automation.list.gate.saveFailed'))
    }
  }

  // Click a automation in the list: switch the right panel to its detail + logs.
  ctx.onSelectAutomation = (id: string): void => {
    selectedAutomationId.value = id
    selectedExecutionId.value = null
    send({ type: 'get_automation_detail', automationId: id })
  }

  // Expand "View session" on an llm-type history item: fetch its transcript once.
  ctx.onLoadExecutionSession = (executionId: string): void => {
    if (!selectedAutomationId.value) return
    send({
      type: 'get_execution_transcript',
      automationId: selectedAutomationId.value,
      executionId,
    })
  }

  // Second-level selection: pick one execution from the selected automation's logs.
  ctx.onSelectExecution = (id: string): void => {
    selectedExecutionId.value = id
  }

  // 两栏 drill-down:从右栏「详情」返回左栏「列表」时清空选中(执行 + automation)。
  ctx.onAutomationMobileBack = (targetKey: string): void => {
    if (targetKey === 'automations') {
      selectedExecutionId.value = null
      selectedAutomationId.value = null
    }
  }

  // 列表行的 enable/disable 开关:映射到 update_automation 的 status。
  ctx.onToggleAutomationEnabled = (id: string, enabled: boolean): void => {
    ctx.updateAutomation(id, { status: enabled ? 'active' : 'paused' })
  }

  // 列表行的「Exec Now」:手动触发一次执行(不改 next_run_at,服务端 triggerRunNow)。
  ctx.runNowAutomation = (id: string): void => {
    send({ type: 'automation_run_now', automationId: id })
  }

  // The modal serves both create (target = null) and edit (target = a automation).
  ctx.openAutomationForm = (target: Automation | null): void => {
    automationFormTarget.value = target
    automationFormOpen.value = true
  }

  // Clear cached tool manifest when the form closes so a fresh open refetches.
  watch(automationFormOpen, (open) => {
    if (!open) {
      automationToolManifest.value = {}
      automationToolManifestLoading.value = false
      automationToolManifestError.value = null
    }
  })

  ctx.createAutomation = (input: CreateAutomationInput): void => {
    automationSaving.value = true
    send({ type: 'create_automation', workspaceId: input.workspaceId, input })
  }

  // Bulk import: dispatch one create per already-mapped input (each carries
  // initialStatus:'paused' so the server lands it paused in a single insert). The
  // list refreshes via the server's automations broadcast; a single-item server
  // failure surfaces through the normal error toast and does not roll back the
  // items already created. A summary toast makes the paused outcome visible.
  ctx.importAutomations = (inputs: CreateAutomationInput[]): void => {
    if (inputs.length === 0) return
    for (const input of inputs) {
      send({ type: 'create_automation', workspaceId: input.workspaceId, input })
    }
    ctx.showToast(
      ctx.t('automation.importExport.import.summary', {
        done: inputs.length,
        total: inputs.length,
      }),
    )
  }

  ctx.createAutomationFromTemplate = (templateId: string): void => {
    const template = getAutomationTemplate(templateId)
    const workspaceId = automationsProject.value
    if (!template || !workspaceId) return
    const agent = findEnabledVendorAgent(ctx.serverSettings.value?.agents ?? [], 'claude')
    if (!agent) {
      ctx.showToast(ctx.t('automation.list.templates.noAgent'))
      return
    }
    ctx.createAutomation(template.build({ workspaceId, agentId: agent.id }))
  }

  ctx.updateAutomation = (id: string, input: UpdateAutomationInput): void => {
    automationSaving.value = true
    send({ type: 'update_automation', automationId: id, input })
  }

  // 列表行的删除:二次确认在 AutomationList 内完成,这里只负责发线协议消息。
  // 服务端硬删除并级联清除执行历史,随后广播 automations 刷新列表。
  ctx.deleteAutomation = (id: string): void => {
    send({ type: 'delete_automation', automationId: id })
  }

  ctx.onLoadAutomationToolManifest = (vendor: string): void => {
    if (!automationsProject.value || !vendor) return
    // Return cached result immediately if we already have it.
    if (automationToolManifest.value[vendor]) {
      automationToolManifestLoading.value = false
      automationToolManifestError.value = null
      return
    }
    automationToolManifestLoading.value = true
    automationToolManifestError.value = null
    send({
      type: 'get_automation_tool_manifest',
      vendor: vendor as VendorId,
      workspaceId: automationsProject.value,
    })
  }

  // ---- Live refresh of the selected, running execution ----
  // A running llm execution's detail/transcript would otherwise stay frozen at
  // the first fetch. While it runs (and the page is the active, visible view) we
  // periodically re-fetch both; on completion we stop after one final transcript
  // fetch so the last content lands. Reuses the existing read-only contracts —
  // no protocol or server change.

  // The selected execution is a refreshable, running llm session.
  const refreshRunning = computed(
    () => selectedAutomation.value?.type === 'llm' && isExecutionRunning(selectedExecution.value),
  )

  let pollTimer: ReturnType<typeof setInterval> | null = null
  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // Re-fetch the running execution's detail (status/duration) + transcript.
  function pollOnce(): void {
    const automationId = selectedAutomationId.value
    const executionId = selectedExecutionId.value
    if (!automationId || !executionId) return
    send({ type: 'get_automation_detail', automationId })
    send({ type: 'get_execution_transcript', automationId, executionId })
  }

  // One final transcript fetch after the run reaches a terminal state.
  function finalFetch(): void {
    const automationId = selectedAutomationId.value
    const executionId = selectedExecutionId.value
    if (!automationId || !executionId) return
    send({ type: 'get_execution_transcript', automationId, executionId })
  }

  // Drive the interval's lifecycle off the running-window: start it when a
  // running execution is selected on the active page, tear it down otherwise,
  // and fire the final fetch on the running → terminal transition.
  watch([refreshRunning, () => activeTab.value], ([running, tab], [prevRunning]) => {
    const tabActive = tab === 'automations'
    const { finalFetch: doFinal } = decideAutomationRefresh({
      running,
      tabActive,
      visible: true,
      prevRunning: !!prevRunning,
    })
    if (doFinal) finalFetch()

    if (running && tabActive) {
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          const { shouldPoll } = decideAutomationRefresh({
            running: refreshRunning.value,
            tabActive: activeTab.value === 'automations',
            visible: document.visibilityState === 'visible',
            prevRunning: refreshRunning.value,
          })
          if (shouldPoll) pollOnce()
        }, AUTOMATION_REFRESH_INTERVAL_MS)
      }
    } else {
      stopPolling()
    }
  })

  // Scope cleanup (no-op outside a component, e.g. unit tests).
  if (getCurrentInstance()) onUnmounted(stopPolling)
}
