/*
 * 队列页的位次展示。位次是服务端每轮对账给出的派生值,页面只照搬:并发阻塞行显示,
 * 其余行连占位都不留;收到新一轮推送后采用新值,不残留上一轮的名次。断言只看
 * data-testid 与结构,不看文案。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Queue from './Queue.vue'
import type { QueueDetail, QueueIntentDetail } from '@ccc/shared/protocol'

function item(over: Partial<QueueIntentDetail> & { intentId: string }): QueueIntentDetail {
  return {
    title: `intent-${over.intentId}`,
    status: 'todo',
    priority: 'P2',
    blockedReason: 'blocked_concurrency_gate',
    blockedDetail: '全局并发闸门',
    nextWakeupAt: null,
    lastAction: 'block',
    lastDecidedAt: null,
    attemptCount: 0,
    backoffCount: 0,
    backoffUntil: null,
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
    workspaceId: 'w1',
    state: 'awaiting_gate',
    tickId: 't1',
    nextWakeupAt: null,
    items,
  }
}

function mountQueue(d: QueueDetail) {
  return mount(Queue, { props: { detail: d } })
}

describe('Queue.vue — 队列位次', () => {
  it('并发阻塞行显示位次,其他行不留占位', () => {
    const w = mountQueue(
      detail([
        item({ intentId: 'A', queuePosition: 1 }),
        item({ intentId: 'B', queuePosition: 2 }),
        item({ intentId: 'C', blockedReason: 'blocked_dependency', blockedDetail: '依赖未完成' }),
      ]),
    )
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
    const w = mountQueue(detail([item({ intentId: 'A', queuePosition: 3 })]))
    expect(w.get('[data-testid="queue-position"]').text()).toContain('3')

    await w.setProps({ detail: detail([item({ intentId: 'A', queuePosition: 1 })]) })
    const after = w.get('[data-testid="queue-position"]').text()
    expect(after).toContain('1')
    expect(after).not.toContain('3')

    await w.setProps({
      detail: detail([item({ intentId: 'A', blockedReason: 'selected', queuePosition: null })]),
    })
    expect(w.find('[data-testid="queue-position"]').exists()).toBe(false)
  })

  it('手动刷新只上抛意图,位次仍由服务端下一次推送决定', async () => {
    const w = mountQueue(detail([item({ intentId: 'A', queuePosition: 2 })]))
    await w.get('[data-testid="queue-refresh"]').trigger('click')
    expect(w.emitted('refresh')).toHaveLength(1)
    // 客户端不自行猜算:点击后页面仍是服务端上一次给的值。
    expect(w.get('[data-testid="queue-position"]').text()).toContain('2')

    await w.setProps({ detail: detail([item({ intentId: 'A', queuePosition: 1 })]) })
    expect(w.get('[data-testid="queue-position"]').text()).toContain('1')
  })
})
