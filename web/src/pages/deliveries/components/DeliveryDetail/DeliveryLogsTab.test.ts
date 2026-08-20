/**
 * The delivery 「日志」 tab: what it renders, and — the part that is easy to get
 * wrong — WHEN it asks for data.
 *
 * `logs === null` is the only signal the tab acts on: it means "never fetched,
 * or dropped by a write". That single rule has to produce a first-open fetch, a
 * re-fetch after invalidation, a fetch when the user switches to another
 * delivery, and NO fetch while one is already in flight or already cached.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { DeliveryLog } from '@ccc/shared/protocol'
import { i18n } from '@/i18n'
import DeliveryLogsTab from './DeliveryLogsTab.vue'

function log(over: Partial<DeliveryLog> & { id: string }): DeliveryLog {
  return {
    deliveryId: 'd1',
    operationType: 'status_changed',
    summary: '状态变更: planned → integrating',
    actor: 'alice',
    createdAt: 1,
    ...over,
    id: over.id,
  }
}

function mountTab(
  props: { logs?: DeliveryLog[] | null; loading?: boolean; deliveryId?: string } = {},
) {
  return mount(DeliveryLogsTab, {
    props: {
      logs: props.logs ?? null,
      loading: props.loading ?? false,
      deliveryId: props.deliveryId ?? 'd1',
    },
  })
}

describe('DeliveryLogsTab — rendering', () => {
  it('shows the loading placeholder while a first fetch is in flight', () => {
    const w = mountTab({ logs: null, loading: true })
    expect(w.find('.delivery-logs-empty').text()).toBeTruthy()
    expect(w.find('[data-testid="delivery-logs-list"]').exists()).toBe(false)
  })

  it('shows the empty placeholder once a fetch came back with nothing', () => {
    const w = mountTab({ logs: [] })
    expect(w.find('[data-testid="delivery-logs-empty"]').exists()).toBe(true)
  })

  it('renders one row per log: localized type label + summary + actor + time', () => {
    const w = mountTab({
      logs: [
        log({
          id: '1',
          operationType: 'delivery_created',
          summary: '创建交付: Sprint 3',
          actor: 'bob',
        }),
        log({
          id: '2',
          operationType: 'intent_linked',
          summary: '关联意图: Add search',
          actor: 'carol',
        }),
      ],
    })
    const rows = w.findAll('.delivery-log-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.delivery-log-op').text()).toBe(
      i18n.global.t('delivery.log.operationType.created'),
    )
    expect(rows[0].find('.delivery-log-summary').text()).toBe('创建交付: Sprint 3')
    expect(rows[0].find('.delivery-log-actor').text()).toBe('bob')
    expect(rows[0].find('.delivery-log-time').text()).toBeTruthy()
    expect(rows[1].find('.delivery-log-op').text()).toBe(
      i18n.global.t('delivery.log.operationType.intentLinked'),
    )
  })

  it('renders the order it is given — the server owns newest-first, the page never re-sorts', () => {
    const w = mountTab({
      logs: [
        log({ id: 'new', summary: 'newest', createdAt: 200 }),
        log({ id: 'old', summary: 'oldest', createdAt: 100 }),
      ],
    })
    expect(w.findAll('.delivery-log-summary').map((n) => n.text())).toEqual(['newest', 'oldest'])
  })

  it('degrades an UNKNOWN operation type to its raw value instead of breaking the list', () => {
    const w = mountTab({
      // A row written by a newer server, or one this build has no label for.
      logs: [log({ id: '1', operationType: 'from_the_future' as DeliveryLog['operationType'] })],
    })
    expect(w.find('[data-testid="delivery-logs-list"]').exists()).toBe(true)
    expect(w.find('.delivery-log-op').text()).toBe('from_the_future')
  })
})

describe('DeliveryLogsTab — when it asks for data', () => {
  it('fetches once on first open (no cache, nothing in flight)', () => {
    const w = mountTab({ logs: null })
    expect(w.emitted('list-logs')).toEqual([['d1']])
  })

  it('does not fetch while a fetch is already in flight', () => {
    const w = mountTab({ logs: null, loading: true })
    expect(w.emitted('list-logs')).toBeFalsy()
  })

  it('does not re-fetch what is already cached', () => {
    const w = mountTab({ logs: [log({ id: '1' })] })
    expect(w.emitted('list-logs')).toBeFalsy()
  })

  it('re-fetches when a write drops the cache while the tab is open', async () => {
    const w = mountTab({ logs: [log({ id: '1' })] })
    expect(w.emitted('list-logs')).toBeFalsy()
    await w.setProps({ logs: null })
    expect(w.emitted('list-logs')).toEqual([['d1']])
  })

  it('fetches the NEW delivery when the open delivery changes, under its own id', async () => {
    const w = mountTab({ logs: null })
    expect(w.emitted('list-logs')).toEqual([['d1']])
    // Switching delivery: the container hands over the other delivery's cache
    // slot, which is empty — so the tab asks for THAT delivery, never re-renders
    // the previous one's rows.
    await w.setProps({ deliveryId: 'd2', logs: null })
    expect(w.emitted('list-logs')).toEqual([['d1'], ['d2']])
  })

  it('renders the delivery it was handed, never the previous one, when the switch is already cached', async () => {
    const w = mountTab({ logs: [log({ id: '1', summary: 'from d1' })] })
    await w.setProps({ deliveryId: 'd2', logs: [log({ id: '2', summary: 'from d2' })] })
    expect(w.findAll('.delivery-log-summary').map((n) => n.text())).toEqual(['from d2'])
    expect(w.emitted('list-logs')).toBeFalsy()
  })
})
