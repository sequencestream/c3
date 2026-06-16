import { watch } from 'vue'
import type {
  CreateScheduleInput,
  Schedule,
  UpdateScheduleInput,
  VendorId,
} from '@ccc/shared/protocol'
import type { AppCtx } from './types'

// Install schedule-tab actions (read path + create/edit form) onto the ctx.
export function installScheduleActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    schedulesProject,
    selectedScheduleId,
    selectedExecutionId,
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

  ctx.onScheduleMobileBack = (targetKey: string): void => {
    if (targetKey === 'history') {
      selectedExecutionId.value = null
      return
    }
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
}
