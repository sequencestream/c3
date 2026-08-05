import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Queue from './Queue.vue'
import type { QueueDetail, QueueIntentDetail } from '@ccc/shared/protocol'

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
    ...over,
  }
}

function mountQueue(items: QueueIntentDetail[]) {
  const detail: QueueDetail = {
    workspaceId: 'ws-1',
    state: 'running',
    tickId: 't-1',
    nextWakeupAt: null,
    items,
  }
  return mount(Queue, { props: { detail } })
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
