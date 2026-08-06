import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
import { resetWriteSpecGuards, useSpecApprovalGate, type MainAction } from './useSpecApprovalGate'

function intent(id: string): Intent {
  return {
    workspaceId: '/proj',
    id,
    title: 'T',
    shortEnTitle: null,
    content: 'B',
    priority: 'P1',
    module: '',
    status: 'todo',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: null,
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: null,
    latestCommitHash: null,
    prs: [],
    specPath: null,
    specStatus: 'raw',
    specMode: null,
    effectiveSpecMode: 'sdd',
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    specReviewSessionId: null,
    specReviewVerdict: null,
    specReviewReason: null,
    specReviewAt: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
    intentSessionId: null,
    sessionActive: false,
    actionDescriptor: null,
  }
}

function mountGate(props: Record<string, unknown> = {}) {
  // switches 用闭包捕获(而非 prop)以记录切 Tab 调用,避免测试组件变更 prop。
  const switches: string[] = []
  const Host = defineComponent({
    props: {
      intentId: { type: String, default: 'i1' },
      mainAction: { type: String as () => MainAction, default: 'writeSpec' },
    },
    setup(hostProps) {
      const gate = useSpecApprovalGate({
        intent: () => intent(hostProps.intentId),
        mainAction: computed(() => hostProps.mainAction),
        onSwitchToSpecSession: () => switches.push(hostProps.intentId),
      })
      return { gate }
    },
    render() {
      return h('div')
    },
  })
  const w = mount(Host, { props })
  const blocked = () =>
    (w.vm as unknown as { gate: ReturnType<typeof useSpecApprovalGate> }).gate.approveGateBlocked
      .value
  const trigger = (id: string) =>
    (w.vm as unknown as { gate: ReturnType<typeof useSpecApprovalGate> }).gate.triggerWriteSpec(id)
  return { w, switches, blocked, trigger }
}

describe('useSpecApprovalGate', () => {
  beforeEach(() => {
    resetWriteSpecGuards()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is not armed for an approveSpec intent whose writeSpec was never clicked', () => {
    const { blocked } = mountGate({ intentId: 'i1', mainAction: 'approveSpec' })
    expect(blocked()).toBe(false)
  })

  it('blocks approval for 10s after writeSpec then unblocks on the timer', async () => {
    const { w, blocked, trigger } = mountGate({ intentId: 'i1', mainAction: 'writeSpec' })
    trigger('i1')
    // 进入 approveSpec 态(specPath 回填后)。
    await w.setProps({ mainAction: 'approveSpec' })
    expect(blocked()).toBe(true)

    vi.advanceTimersByTime(9999)
    await w.vm.$nextTick()
    expect(blocked()).toBe(true)

    vi.advanceTimersByTime(1)
    await w.vm.$nextTick()
    expect(blocked()).toBe(false)
  })

  it('switches to the spec session tab ~1s after writeSpec when the intent is unchanged', async () => {
    const { switches, trigger } = mountGate({ intentId: 'i1' })
    trigger('i1')
    vi.advanceTimersByTime(999)
    expect(switches).toEqual([])
    vi.advanceTimersByTime(1)
    expect(switches).toEqual(['i1'])
  })

  it('does not steal the tab back if the intent switched within 1s', async () => {
    const { w, switches, trigger } = mountGate({ intentId: 'a' })
    trigger('a')
    await w.setProps({ intentId: 'b' })
    vi.advanceTimersByTime(1000)
    expect(switches).toEqual([])
  })

  it('survives a remount within the 10s window (module-level guard, no bypass)', async () => {
    const first = mountGate({ intentId: 'i1', mainAction: 'writeSpec' })
    first.trigger('i1')
    vi.advanceTimersByTime(4000)
    first.w.unmount()

    const second = mountGate({ intentId: 'i1', mainAction: 'approveSpec' })
    expect(second.blocked()).toBe(true)
    vi.advanceTimersByTime(6000)
    await second.w.vm.$nextTick()
    expect(second.blocked()).toBe(false)
  })

  it('clears pending timers on unmount without switching', () => {
    const { w, switches, trigger } = mountGate({ intentId: 'i1' })
    trigger('i1')
    w.unmount()
    expect(() => vi.advanceTimersByTime(10000)).not.toThrow()
    expect(switches).toEqual([])
  })
})
