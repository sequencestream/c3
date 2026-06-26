import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ServerToClient } from '@ccc/shared/protocol'
import { installMessageHandler } from './message-handler'
import type { AppCtx } from './types'

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
  const scheduleSaving = ref(false)
  const schedules = ref({})
  const schedulesProject = ref<string | null>(null)
  const activeTab = ref<string>('console')
  const selectedScheduleId = ref<string | null>(null)
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
    scheduleSaving,
    schedules,
    schedulesProject,
    activeTab,
    selectedScheduleId,
    add: vi.fn(),
  } as unknown as AppCtx
  installMessageHandler(ctx)
  return {
    ctx,
    toast,
    intentActionError,
    intentActionErrorSeq,
    closeDevLaunch,
    dispatchSpecLaunch,
    showToast,
    showIntentActionError,
    scheduleSaving,
    schedules,
    schedulesProject,
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

describe('schedule save overlay message handler', () => {
  it('clears scheduleSaving on schedules broadcast', () => {
    const result = makeCtx()
    result.scheduleSaving.value = true

    result.ctx.handleMessage({
      type: 'schedules',
      workspaceId: 'ws1',
      items: [],
    } as unknown as ServerToClient)

    expect(result.scheduleSaving.value).toBe(false)
  })

  it('clears scheduleSaving on schedule error', () => {
    const result = makeCtx()
    result.scheduleSaving.value = true

    result.ctx.handleMessage(error('schedule.agentRequired'))

    expect(result.scheduleSaving.value).toBe(false)
  })

  it('clears scheduleSaving on generic error', () => {
    const result = makeCtx()
    result.scheduleSaving.value = true

    result.ctx.handleMessage(error('workspace.unknown'))

    expect(result.scheduleSaving.value).toBe(false)
  })
})
