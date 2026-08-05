import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { QueueDetail, QueueIntentDetail } from '@ccc/shared/protocol'
import Queue from './Queue.vue'

/*
 * 队列页的退避/冷却倒计时。等待期间界面必须持续给出反馈,并在服务端给出的截止时刻催
 * 一次(且只催一次)刷新——真正的结论仍来自下一轮对账。断言只看 data-testid / emitted /
 * 插值出来的数字,不看文案本身。
 */

const NOW = 1_700_000_000_000

function item(over: Partial<QueueIntentDetail> = {}): QueueIntentDetail {
  return {
    intentId: 'i1',
    title: 'Intent one',
    status: 'todo',
    priority: 'P1',
    blockedReason: 'blocked_backoff',
    blockedDetail: '',
    nextWakeupAt: NOW + 65_000,
    lastAction: 'block',
    lastDecidedAt: NOW - 1_000,
    attemptCount: 1,
    backoffCount: 1,
    backoffUntil: NOW + 65_000,
    parked: false,
    parkReason: null,
    parkDetail: null,
    forceSkipped: false,
    ...over,
  }
}

function detail(items: QueueIntentDetail[]): QueueDetail {
  return {
    workspaceId: '/home/proj',
    state: 'running',
    tickId: 'tick-1',
    nextWakeupAt: null,
    items,
  }
}

function mountQueue(items: QueueIntentDetail[]) {
  return mount(Queue, { props: { detail: detail(items) } })
}

/** 每条行上的倒计时文本(没有倒计时的行不出现该元素)。 */
function countdowns(wrapper: ReturnType<typeof mountQueue>): string[] {
  return wrapper.findAll('[data-testid="queue-countdown"]').map((el) => el.text())
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Queue 倒计时展示', () => {
  it('只对退避与冷却且截止时间在未来的行展示倒计时', async () => {
    const wrapper = mountQueue([
      item({ intentId: 'backoff' }),
      item({ intentId: 'cooldown', blockedReason: 'blocked_cooldown', nextWakeupAt: NOW + 5_000 }),
      item({ intentId: 'dependency', blockedReason: 'blocked_dependency', nextWakeupAt: null }),
      // 依赖闸门即便带上唤醒时间也不倒计时:它不是纯等时钟的阻塞。
      item({ intentId: 'dep-with-wake', blockedReason: 'blocked_dependency' }),
      item({ intentId: 'parked', blockedReason: 'blocked_parked', parked: true }),
      // 截止时间已过:不显示倒计时(也不显示负数)。
      item({ intentId: 'stale', nextWakeupAt: NOW - 1_000 }),
    ])
    await wrapper.vm.$nextTick()

    expect(countdowns(wrapper)).toHaveLength(2)
  })

  it('跨分钟用「分:秒」、不足一分钟用秒,且不足一秒向上取整', async () => {
    const wrapper = mountQueue([
      item({ intentId: 'long', nextWakeupAt: NOW + 125_000 }),
      item({ intentId: 'short', nextWakeupAt: NOW + 9_000 }),
      item({ intentId: 'sub-second', nextWakeupAt: NOW + 200 }),
    ])
    await wrapper.vm.$nextTick()

    const [long, short, subSecond] = countdowns(wrapper)
    expect(long).toContain('2:05')
    expect(short).toContain('9')
    // 不足一秒仍显示 1 秒,而不是提前显示成 0 / 已到点。
    expect(subSecond).toContain('1')
    expect(wrapper.findAll('[data-testid="queue-countdown"]')).toHaveLength(3)
  })

  it('按秒递减且到点后倒计时消失', async () => {
    const wrapper = mountQueue([item({ nextWakeupAt: NOW + 3_000 })])
    await wrapper.vm.$nextTick()
    expect(countdowns(wrapper)[0]).toContain('3')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(countdowns(wrapper)[0]).toContain('2')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(countdowns(wrapper)[0]).toContain('1')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(countdowns(wrapper)).toHaveLength(0)
  })
})

describe('Queue 到点刷新', () => {
  it('到点只发一次 refresh,之后继续走时钟也不重复发', async () => {
    const wrapper = mountQueue([item({ nextWakeupAt: NOW + 2_000 })])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(wrapper.emitted('refresh')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(wrapper.emitted('refresh')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('多条同时到点也只发一次刷新', async () => {
    const wrapper = mountQueue([
      item({ intentId: 'a', nextWakeupAt: NOW + 1_000 }),
      item({ intentId: 'b', nextWakeupAt: NOW + 1_000 }),
    ])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })

  it('新投影带来新的截止时间时重新武装倒计时与刷新', async () => {
    const wrapper = mountQueue([item({ nextWakeupAt: NOW + 1_000 })])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(wrapper.emitted('refresh')).toHaveLength(1)

    // 服务端返回:仍在退避,但截止时间被推后。
    await wrapper.setProps({ detail: detail([item({ nextWakeupAt: NOW + 4_000 })]) })
    expect(countdowns(wrapper)[0]).toContain('3')

    await vi.advanceTimersByTimeAsync(3_000)
    expect(countdowns(wrapper)).toHaveLength(0)
    expect(wrapper.emitted('refresh')).toHaveLength(2)
  })

  it('条目离开退避/冷却后旧计时停止,不再倒计时也不再刷新', async () => {
    const wrapper = mountQueue([item({ nextWakeupAt: NOW + 3_000 })])

    await wrapper.setProps({
      detail: detail([item({ blockedReason: 'selected', nextWakeupAt: null })]),
    })
    expect(countdowns(wrapper)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(wrapper.emitted('refresh')).toBeUndefined()
  })

  it('卸载后计时器被清理,不再产生副作用', async () => {
    const wrapper = mountQueue([item({ nextWakeupAt: NOW + 2_000 })])
    await wrapper.vm.$nextTick()

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(wrapper.emitted('refresh')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
