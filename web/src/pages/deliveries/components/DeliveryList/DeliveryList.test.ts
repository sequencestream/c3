import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Delivery } from '@ccc/shared/protocol'
import DeliveryList from './DeliveryList.vue'

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceId: 'w1',
    title: 'Sprint 3',
    description: '',
    status: 'planned',
    startDate: null,
    endDate: null,
    branchName: null,
    baseBranch: 'main',
    branchReady: false,
    integration: { total: 0, merged: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('DeliveryList', () => {
  it('renders rows with the N/M aggregate inline (no separate progress bar)', () => {
    const w = mount(DeliveryList, {
      props: { deliveries: [delivery()], activeId: null },
    })
    expect(w.find('[data-testid="delivery-list-empty"]').exists()).toBe(false)
    const rows = w.findAll('[data-testid^="delivery-row-"]')
    expect(rows.length).toBeGreaterThan(0)
    expect(w.find('[data-testid="delivery-row-ready"]').exists()).toBe(true)
    // 无独立进度条/统计卡。
    expect(w.find('[data-testid="delivery-progress"]').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-timeline"]').exists()).toBe(false)
  })

  it('emits open on row click', async () => {
    const w = mount(DeliveryList, {
      props: { deliveries: [delivery()], activeId: null },
    })
    await w.find('[data-testid^="delivery-row-"]').trigger('click')
    expect(w.emitted('open')?.[0]).toEqual(['d1'])
  })

  it('shows the empty state when there are no deliveries', () => {
    const w = mount(DeliveryList, { props: { deliveries: [], activeId: null } })
    expect(w.find('[data-testid="delivery-list-empty"]').exists()).toBe(true)
  })

  it('emits create with title/description/dates from the inline form', async () => {
    const w = mount(DeliveryList, { props: { deliveries: [], activeId: null } })
    await w.find('[data-testid="delivery-new-btn"]').trigger('click')
    await w.find('[data-testid="delivery-create-title"]').setValue('Release X')
    await w.find('[data-testid="delivery-create-desc"]').setValue('the batch')
    await w.find('[data-testid="delivery-create-start"]').setValue('2026-08-06')
    await w.find('[data-testid="delivery-create-submit"]').trigger('submit')
    const created = w.emitted('create')?.[0]?.[0] as {
      title: string
      description: string
      startDate: number | null
    }
    expect(created.title).toBe('Release X')
    expect(created.description).toBe('the batch')
    expect(created.startDate).toBe(Number(new Date('2026-08-06T00:00:00Z').getTime()))
  })
})
