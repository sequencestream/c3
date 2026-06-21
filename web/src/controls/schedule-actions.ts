import { computed, getCurrentInstance, onUnmounted, watch } from 'vue'
import type {
  CreateScheduleInput,
  Schedule,
  UpdateScheduleInput,
  VendorId,
} from '@ccc/shared/protocol'
import {
  SCHEDULE_REFRESH_INTERVAL_MS,
  decideScheduleRefresh,
  isExecutionRunning,
} from '@/lib/schedule-refresh'
import type { AppCtx } from './types'

// Install schedule-tab actions (read path + create/edit form) onto the ctx.
export function installScheduleActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    activeTab,
    schedulesProject,
    selectedScheduleId,
    selectedExecutionId,
    selectedSchedule,
    selectedExecution,
    scheduleFormOpen,
    scheduleFormTarget,
    scheduleToolManifest,
    scheduleToolManifestLoading,
    scheduleToolManifestError,
  } = ctx

  // Enter the schedules view for a project: fetch its list and reset the right pane.
  ctx.openSchedules = (path: string): void => {
    ctx.activeTab.value = 'schedules'
    schedulesProject.value = path
    selectedScheduleId.value = null
    ctx.persistViewMode()
    send({ type: 'list_schedules', workspaceId: path })
    // Pull settings so the next-run preview uses the configured `timezone`.
    send({ type: 'get_settings' })
  }

  // Click a schedule in the list: switch the right panel to its detail + logs.
  ctx.onSelectSchedule = (id: string): void => {
    selectedScheduleId.value = id
    selectedExecutionId.value = null
    send({ type: 'get_schedule_detail', scheduleId: id })
  }

  // Expand "View session" on an llm-type history item: fetch its transcript once.
  ctx.onLoadExecutionSession = (executionId: string): void => {
    if (!selectedScheduleId.value) return
    send({
      type: 'get_execution_transcript',
      scheduleId: selectedScheduleId.value,
      executionId,
    })
  }

  // Second-level selection: pick one execution from the selected schedule's logs.
  ctx.onSelectExecution = (id: string): void => {
    selectedExecutionId.value = id
  }

  // 两栏 drill-down:从右栏「详情」返回左栏「列表」时清空选中(执行 + schedule)。
  ctx.onScheduleMobileBack = (targetKey: string): void => {
    if (targetKey === 'schedules') {
      selectedExecutionId.value = null
      selectedScheduleId.value = null
    }
  }

  // 列表行的 enable/disable 开关:映射到 update_schedule 的 status。
  ctx.onToggleScheduleEnabled = (id: string, enabled: boolean): void => {
    ctx.updateSchedule(id, { status: enabled ? 'active' : 'paused' })
  }

  // 列表行的「Exec Now」:手动触发一次执行(不改 next_run_at,服务端 triggerRunNow)。
  ctx.runNowSchedule = (id: string): void => {
    send({ type: 'schedule_run_now', scheduleId: id })
  }

  // The modal serves both create (target = null) and edit (target = a schedule).
  ctx.openScheduleForm = (target: Schedule | null): void => {
    scheduleFormTarget.value = target
    scheduleFormOpen.value = true
  }

  // Clear cached tool manifest when the form closes so a fresh open refetches.
  watch(scheduleFormOpen, (open) => {
    if (!open) {
      scheduleToolManifest.value = {}
      scheduleToolManifestLoading.value = false
      scheduleToolManifestError.value = null
    }
  })

  ctx.createSchedule = (input: CreateScheduleInput): void => {
    send({ type: 'create_schedule', workspaceId: input.workspaceId, input })
  }

  ctx.updateSchedule = (id: string, input: UpdateScheduleInput): void => {
    send({ type: 'update_schedule', scheduleId: id, input })
  }

  // 列表行的删除:二次确认在 ScheduleList 内完成,这里只负责发线协议消息。
  // 服务端硬删除并级联清除执行历史,随后广播 schedules 刷新列表。
  ctx.deleteSchedule = (id: string): void => {
    send({ type: 'delete_schedule', scheduleId: id })
  }

  ctx.onLoadScheduleToolManifest = (vendor: string): void => {
    if (!schedulesProject.value || !vendor) return
    // Return cached result immediately if we already have it.
    if (scheduleToolManifest.value[vendor]) {
      scheduleToolManifestLoading.value = false
      scheduleToolManifestError.value = null
      return
    }
    scheduleToolManifestLoading.value = true
    scheduleToolManifestError.value = null
    send({
      type: 'get_schedule_tool_manifest',
      vendor: vendor as VendorId,
      workspaceId: schedulesProject.value,
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
    () => selectedSchedule.value?.type === 'llm' && isExecutionRunning(selectedExecution.value),
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
    const scheduleId = selectedScheduleId.value
    const executionId = selectedExecutionId.value
    if (!scheduleId || !executionId) return
    send({ type: 'get_schedule_detail', scheduleId })
    send({ type: 'get_execution_transcript', scheduleId, executionId })
  }

  // One final transcript fetch after the run reaches a terminal state.
  function finalFetch(): void {
    const scheduleId = selectedScheduleId.value
    const executionId = selectedExecutionId.value
    if (!scheduleId || !executionId) return
    send({ type: 'get_execution_transcript', scheduleId, executionId })
  }

  // Drive the interval's lifecycle off the running-window: start it when a
  // running execution is selected on the active page, tear it down otherwise,
  // and fire the final fetch on the running → terminal transition.
  watch([refreshRunning, () => activeTab.value], ([running, tab], [prevRunning]) => {
    const tabActive = tab === 'schedules'
    const { finalFetch: doFinal } = decideScheduleRefresh({
      running,
      tabActive,
      visible: true,
      prevRunning: !!prevRunning,
    })
    if (doFinal) finalFetch()

    if (running && tabActive) {
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          const { shouldPoll } = decideScheduleRefresh({
            running: refreshRunning.value,
            tabActive: activeTab.value === 'schedules',
            visible: document.visibilityState === 'visible',
            prevRunning: refreshRunning.value,
          })
          if (shouldPoll) pollOnce()
        }, SCHEDULE_REFRESH_INTERVAL_MS)
      }
    } else {
      stopPolling()
    }
  })

  // Scope cleanup (no-op outside a component, e.g. unit tests).
  if (getCurrentInstance()) onUnmounted(stopPolling)
}
