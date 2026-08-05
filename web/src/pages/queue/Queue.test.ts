import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { QueueDetail, QueueIntentDetail } from '@ccc/shared/protocol'
import Queue from './Queue.vue'

/*
 * Queue.vue — park 条目的原因说明与一键解除。
 *
 * 两件事必须成立:park 的条目要说清「为什么被 park」(结构化原因码本地化,未知码回退
 * 原文,缺失原因给出占位),以及「解除 park」只在 park 行渲染、点击只发一次针对该条
 * intentId 的 unpark。断言一律基于 data-testid / emitted / 结构,不基于可见文案。
 *
 * 客户端不预测结果:这里只验证上抛一次动作,是否真的解除由服务端校验后经 queue_detail
 * 推送决定(被拒绝的控制走全局 toast,见 controls/message-handler)。
 */

/*
 * 队列页的退避/冷却倒计时。等待期间界面必须持续给出反馈,并在服务端给出的截止时刻催
 * 一次(且只催一次)刷新——真正的结论仍来自下一轮对账。断言只看 data-testid / emitted /
 * 插值出来的数字,不看文案本身。
 */

/*
 * 队列页的位次展示。位次是服务端每轮对账给出的派生值,页面只照搬:并发阻塞行显示,
 * 其余行连占位都不留;收到新一轮推送后采用新值,不残留上一轮的名次。断言只看
 * data-testid 与结构,不看文案。
 */

const NOW = 1_700_000_000_000

/** park 套件用的行工厂:parker 行默认值(阻塞原因 park、无唤醒时刻)。 */
function row(over: Partial<QueueIntentDetail> = {}): QueueIntentDetail {
  return {
    intentId: 'A',
    title: '意图 A',
    status: 'todo',
    priority: 'P1',
    blockedReason: 'blocked_parked',
    blockedDetail: '',
    nextWakeupAt: null,
    lastAction: 'park',
    lastDecidedAt: null,
    attemptCount: 3,
    backoffCount: 2,
    backoffUntil: null,
    parked: false,
    parkReason: null,
    parkDetail: null,
    forceSkipped: false,
    queuePosition: null,
    ...over,
  }
}

/** 倒计时套件用的行工厂:退避/冷却行默认值(带未来的唤醒时刻)。 */
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
    queuePosition: null,
    ...over,
  }
}

function detail(items: QueueIntentDetail[]): QueueDetail {
  return {
    workspaceId: 'ws-1',
    state: 'running',
    tickId: 't-1',
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

describe('Queue.vue — park 原因展示', () => {
  it('park 条目同时给出「已 park」徽标、原因文本、详情与解除按钮', () => {
    const w = mountQueue([
      row({
        parked: true,
        parkReason: 'max_attempts_reached',
        parkDetail: '连续 3 次失败',
      }),
    ])

    expect(w.find('.queue-badge-parked').exists()).toBe(true)
    const reason = w.find('[data-testid="queue-park-reason"]')
    expect(reason.exists()).toBe(true)
    // 结构化原因码被本地化:渲染出的不是原始码本身。
    expect(reason.text()).not.toBe('max_attempts_reached')
    expect(reason.text()).not.toContain('max_attempts_reached')
    expect(reason.text()).toContain('连续 3 次失败')
    expect(w.find('[data-testid="queue-unpark"]').exists()).toBe(true)
  })

  it('未知原因码回退显示原始码,不显示空白', () => {
    const w = mountQueue([row({ parked: true, parkReason: 'some_unmapped_code' })])

    expect(w.find('[data-testid="queue-park-reason"]').text()).toBe('some_unmapped_code')
  })

  it('缺失原因显示「无原因」占位,不渲染 null/空串', () => {
    const w = mountQueue([row({ parked: true, parkReason: null })])

    const text = w.find('[data-testid="queue-park-reason"]').text()
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain('null')
  })

  it('非 park 条目既不显示 park 原因也不显示解除按钮', () => {
    const w = mountQueue([
      // 当前阻塞原因不是 park 原因:退避中的条目照样不展示 park 说明。
      row({ parked: false, blockedReason: 'blocked_backoff', backoffUntil: 1_800_000_000_000 }),
    ])

    expect(w.find('.queue-badge-parked').exists()).toBe(false)
    expect(w.find('[data-testid="queue-park-reason"]').exists()).toBe(false)
    expect(w.find('[data-testid="queue-unpark"]').exists()).toBe(false)
    // 阻塞原因行仍在:park 说明缺席不等于这条没有原因可看。
    expect(w.find('[data-testid="queue-blocked"]').exists()).toBe(true)
  })
})

describe('Queue.vue — 一键解除 park', () => {
  it('点击只上抛一次 unpark,且带的是该条的 intentId', async () => {
    const w = mountQueue([row({ parked: true, parkReason: 'commit_failed' })])

    await w.find('[data-testid="queue-unpark"]').trigger('click')

    expect(w.emitted('control')).toEqual([['unpark', 'A']])
  })

  it('多条目下解除的是被点击的那一条,不是第一条', async () => {
    const w = mountQueue([
      row({ intentId: 'A', title: '意图 A', parked: true, parkReason: 'turn_error' }),
      row({ intentId: 'B', title: '意图 B', parked: true, parkReason: 'commit_failed' }),
    ])

    const buttons = w.findAll('[data-testid="queue-unpark"]')
    expect(buttons).toHaveLength(2)
    await buttons[1].trigger('click')

    expect(w.emitted('control')).toEqual([['unpark', 'B']])
  })

  it('解除按钮不乐观改写本地状态:未收到新投影前该条仍是 park', async () => {
    const w = mountQueue([row({ parked: true, parkReason: 'judge_stuck' })])

    await w.find('[data-testid="queue-unpark"]').trigger('click')

    expect(w.find('.queue-badge-parked').exists()).toBe(true)
    expect(w.find('[data-testid="queue-park-reason"]').exists()).toBe(true)
  })
})

describe('Queue.vue — 队列位次', () => {
  it('并发阻塞行显示位次,其他行不留占位', () => {
    const w = mountQueue([
      item({ intentId: 'A', blockedReason: 'blocked_concurrency_gate', queuePosition: 1 }),
      item({ intentId: 'B', blockedReason: 'blocked_concurrency_gate', queuePosition: 2 }),
      item({ intentId: 'C', blockedReason: 'blocked_dependency', blockedDetail: '依赖未完成' }),
    ])
    const shown = w.findAll('[data-testid="queue-position"]')
    expect(shown).toHaveLength(2)
    expect(shown[0]!.text()).toContain('1')
    expect(shown[1]!.text()).toContain('2')
    // 第三行仍然渲染,只是没有位次这一段。
    expect(w.findAll('[data-testid="queue-row"]')).toHaveLength(3)
    expect(
      w
        .findAll('[data-testid="queue-blocked"]')[2]!
        .find('[data-testid="queue-position"]')
        .exists(),
    ).toBe(false)
  })

  it('后续推送的位次覆盖上一轮,清空即不再显示', async () => {
    const w = mountQueue([
      item({ intentId: 'A', blockedReason: 'blocked_concurrency_gate', queuePosition: 3 }),
    ])
    expect(w.get('[data-testid="queue-position"]').text()).toContain('3')

    await w.setProps({
      detail: detail([
        item({ intentId: 'A', blockedReason: 'blocked_concurrency_gate', queuePosition: 1 }),
      ]),
    })
    const after = w.get('[data-testid="queue-position"]').text()
    expect(after).toContain('1')
    expect(after).not.toContain('3')

    await w.setProps({
      detail: detail([item({ intentId: 'A', blockedReason: 'selected', queuePosition: null })]),
    })
    expect(w.find('[data-testid="queue-position"]').exists()).toBe(false)
  })

  it('手动刷新只上抛意图,位次仍由服务端下一次推送决定', async () => {
    const w = mountQueue([
      item({ intentId: 'A', blockedReason: 'blocked_concurrency_gate', queuePosition: 2 }),
    ])
    await w.get('[data-testid="queue-refresh"]').trigger('click')
    expect(w.emitted('refresh')).toHaveLength(1)
    // 客户端不自行猜算:点击后页面仍是服务端上一次给的值。
    expect(w.get('[data-testid="queue-position"]').text()).toContain('2')

    await w.setProps({
      detail: detail([
        item({ intentId: 'A', blockedReason: 'blocked_concurrency_gate', queuePosition: 1 }),
      ]),
    })
    expect(w.get('[data-testid="queue-position"]').text()).toContain('1')
  })
})

describe('Queue 倒计时展示', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

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
