import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Discussion, ResearchMessage, ServerToClient } from '@ccc/shared/protocol'
import { installMessageHandler } from './message-handler'
import type { ChatMsg } from '@/lib/chat-types'
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
  // Discussion / research refs touched by discussion_detail + research_message.
  const serverSettings = ref(null)
  const activeDiscussion = ref<Discussion | null>(null)
  const activeDiscussionId = ref<string | null>(null)
  const discussionMessages = ref<ChatMsg[]>([])
  const discussionMaxSeq = ref(0)
  const researchMessages = ref<ChatMsg[]>([])
  const researchMaxSeq = ref(0)
  const persistViewMode = vi.fn()
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
    serverSettings,
    activeDiscussion,
    activeDiscussionId,
    discussionMessages,
    discussionMaxSeq,
    researchMessages,
    researchMaxSeq,
    persistViewMode,
    // The handler reads `ctx.t` at install time; a passthrough is enough here.
    t: (key: string) => key,
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
