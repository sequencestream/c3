/*
 * DeliveryIntentsTab —— 关联意图列表 / 关联入口 / 解除关联。
 *
 * 最要紧的一条:第三列必须是「该意图对本交付的 PR 状态」。构造同一意图对两个交付
 * 各一条 PR、状态不同的场景,分别挂载两个交付的行数据,验证各自显示自己的那条。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AssociatedIntent, Delivery, Intent } from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import DeliveryIntentsTab from './DeliveryIntentsTab.vue'

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceId: 'w1',
    title: 'Sprint 3',
    description: '',
    status: 'integrating',
    startDate: null,
    endDate: null,
    branchName: 'delivery/sprint-3',
    baseBranch: 'main',
    branchReady: true,
    integration: { total: 1, merged: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function row(over: Partial<AssociatedIntent> = {}): AssociatedIntent {
  return {
    id: 'i1',
    title: 'Alpha',
    status: 'todo',
    prStatus: null,
    headBranch: null,
    ...over,
  }
}

function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i9',
    title: 'Free intent',
    linkedDeliveries: [],
    ...over,
  } as unknown as Intent
}

function mountTab(over: { rows?: AssociatedIntent[]; intents?: Intent[] } = {}) {
  return mount(DeliveryIntentsTab, {
    props: {
      delivery: delivery(),
      associatedIntents: over.rows ?? [],
      intents: over.intents ?? [],
    },
  })
}

describe('DeliveryIntentsTab', () => {
  it('renders the empty state when nothing is linked', () => {
    const w = mountTab()
    expect(w.find('[data-testid="delivery-intents-empty"]').exists()).toBe(true)
  })

  it('renders one row per linked intent', () => {
    const w = mountTab({ rows: [row(), row({ id: 'i2', title: 'Beta' })] })
    expect(w.find('[data-testid="delivery-intents-empty"]').exists()).toBe(false)
    expect(w.findAll('[data-testid^="delivery-intent-row-"]').length).toBe(2)
  })

  it("shows THIS delivery's PR status — the same intent reads differently per delivery", () => {
    // One intent, two PRs against two different bases. Each delivery's own list
    // carries its own row; the tab must render exactly what it was handed.
    const towardD1 = mountTab({ rows: [row({ prStatus: 'merged', headBranch: 'feat/x' })] })
    const towardD2 = mountTab({ rows: [row({ prStatus: 'reviewing', headBranch: 'feat/x' })] })

    expect(towardD1.find('[data-testid="delivery-intent-pr-i1"]').classes()).toContain(
      'req-pr-status--merged',
    )
    expect(towardD2.find('[data-testid="delivery-intent-pr-i1"]').classes()).toContain(
      'req-pr-status--reviewing',
    )
    expect(towardD1.find('[data-testid="delivery-intent-pr-i1"]').classes()).not.toContain(
      'req-pr-status--reviewing',
    )
  })

  it('disables unlink on a merged row and keeps it live otherwise', () => {
    const merged = mountTab({ rows: [row({ prStatus: 'merged' })] })
    expect(merged.find('[data-testid="delivery-intent-unlink-i1"]').attributes('disabled')).toBe('')

    const open = mountTab({ rows: [row({ prStatus: 'reviewing' })] })
    expect(open.find('[data-testid="delivery-intent-unlink-i1"]').attributes('disabled')).toBe(
      undefined,
    )
  })

  it('asks for confirmation before emitting an unlink', async () => {
    const w = mountTab({ rows: [row({ prStatus: 'reviewing' })] })
    expect(w.findComponent(ConfirmDialog).props('open')).toBe(false)

    await w.find('[data-testid="delivery-intent-unlink-i1"]').trigger('click')
    expect(w.findComponent(ConfirmDialog).props('open')).toBe(true)
    expect(w.emitted('unlink')).toBeUndefined()

    w.findComponent(ConfirmDialog).vm.$emit('confirm')
    expect(w.emitted('unlink')).toEqual([['i1']])
  })

  it('cancelling the confirmation emits nothing', async () => {
    const w = mountTab({ rows: [row({ prStatus: 'reviewing' })] })
    await w.find('[data-testid="delivery-intent-unlink-i1"]').trigger('click')
    w.findComponent(ConfirmDialog).vm.$emit('cancel')
    await w.vm.$nextTick()
    expect(w.emitted('unlink')).toBeUndefined()
    expect(w.findComponent(ConfirmDialog).props('open')).toBe(false)
  })

  it('offers only intents that belong to NO delivery (no multi-delivery entry point)', async () => {
    const w = mountTab({
      intents: [
        intent({ id: 'free', title: 'Free' }),
        intent({ id: 'taken', title: 'Taken', linkedDeliveries: [{ id: 'dX', title: 'Other' }] }),
      ],
    })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    const options = w.findAll('[data-testid="delivery-intents-picker"] option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['free'])

    await w.find('[data-testid="delivery-intents-link-confirm"]').trigger('click')
    expect(w.emitted('link')).toEqual([['free']])
  })

  it('shows the picker empty state when every intent already belongs to a delivery', async () => {
    const w = mountTab({
      intents: [intent({ id: 'taken', linkedDeliveries: [{ id: 'dX', title: 'Other' }] })],
    })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    expect(w.find('[data-testid="delivery-intents-picker-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-intents-link-confirm"]').exists()).toBe(false)
  })
})
