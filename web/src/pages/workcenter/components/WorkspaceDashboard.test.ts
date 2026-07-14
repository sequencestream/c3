/**
 * Dashboard.vue coverage: the cross-workspace table, its admin-only multi-select
 * + bulk gate controls, per-row gate/failure rendering, and the empty / loading /
 * refresh-failed states. Assertions key off structure / data-testid / emitted
 * events, never visible copy (i18n-spec §4).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Dashboard from './WorkspaceDashboard.vue'
import type { WorkspaceDashboardRow } from '@ccc/shared/protocol'

function row(id: string, over: Partial<WorkspaceDashboardRow> = {}): WorkspaceDashboardRow {
  return {
    workspaceId: id,
    name: id,
    path: `/abs/${id}`,
    sessions: { running: 1, total: 3 },
    intents: { total: 2 },
    discussions: { total: 4 },
    automations: { total: 5 },
    automationEnabled: true,
    ...over,
  }
}

function props(over: Record<string, unknown> = {}) {
  return {
    rows: [row('a'), row('b')],
    loading: false,
    refreshFailed: false,
    selected: new Set<string>(),
    failedIds: new Set<string>(),
    busy: false,
    isAdmin: true,
    ...over,
  }
}

describe('Dashboard.vue', () => {
  it('renders one row per workspace', () => {
    const wrapper = mount(Dashboard, { props: props() })
    expect(wrapper.findAll('.dash-table tbody tr')).toHaveLength(2)
  })

  it('shows select controls for an admin and hides them for a viewer', () => {
    const admin = mount(Dashboard, { props: props() })
    expect(admin.find('[data-testid="dash-select-all"]').exists()).toBe(true)
    expect(admin.findAll('.dash-row-check')).toHaveLength(2)

    const viewer = mount(Dashboard, { props: props({ isAdmin: false }) })
    expect(viewer.find('[data-testid="dash-select-all"]').exists()).toBe(false)
    expect(viewer.findAll('.dash-row-check')).toHaveLength(0)
    // A viewer still sees the gate state.
    expect(viewer.findAll('.dash-gate')).toHaveLength(2)
  })

  it('disables the bulk buttons with no selection', () => {
    const wrapper = mount(Dashboard, { props: props() })
    expect(wrapper.find('[data-testid="dash-bulk-enable"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="dash-bulk-disable"]').attributes('disabled')).toBeDefined()
  })

  it('enables the bulk buttons with a selection and no in-flight request', () => {
    const wrapper = mount(Dashboard, { props: props({ selected: new Set(['a']) }) })
    expect(wrapper.find('[data-testid="dash-bulk-enable"]').attributes('disabled')).toBeUndefined()
  })

  it('disables the bulk buttons while a request is in flight', () => {
    const wrapper = mount(Dashboard, { props: props({ selected: new Set(['a']), busy: true }) })
    expect(wrapper.find('[data-testid="dash-bulk-enable"]').attributes('disabled')).toBeDefined()
  })

  it('emits bulk(true/false) from the enable/disable buttons', async () => {
    const wrapper = mount(Dashboard, { props: props({ selected: new Set(['a']) }) })
    await wrapper.find('[data-testid="dash-bulk-enable"]').trigger('click')
    await wrapper.find('[data-testid="dash-bulk-disable"]').trigger('click')
    expect(wrapper.emitted('bulk')).toEqual([[true], [false]])
  })

  it('emits toggle-all and toggle-workspace from the checkboxes', async () => {
    const wrapper = mount(Dashboard, { props: props() })
    await wrapper.find('[data-testid="dash-select-all"]').trigger('change')
    expect(wrapper.emitted('toggle-all')).toHaveLength(1)
    await wrapper.findAll('.dash-row-check')[1].trigger('change')
    expect(wrapper.emitted('toggle-workspace')).toEqual([['b']])
  })

  it('reflects the gate state per row', () => {
    const wrapper = mount(Dashboard, {
      props: props({
        rows: [row('a', { automationEnabled: true }), row('b', { automationEnabled: false })],
      }),
    })
    const gates = wrapper.findAll('.dash-gate')
    expect(gates[0].classes()).toContain('on')
    expect(gates[1].classes()).toContain('off')
  })

  it('flags rows in failedIds', () => {
    const wrapper = mount(Dashboard, { props: props({ failedIds: new Set(['b']) }) })
    const rows = wrapper.findAll('.dash-table tbody tr')
    expect(rows[0].classes()).not.toContain('dash-row-failed')
    expect(rows[1].classes()).toContain('dash-row-failed')
    expect(rows[1].find('.dash-failed-tag').exists()).toBe(true)
  })

  it('shows the empty state and no table when there are no rows', () => {
    const wrapper = mount(Dashboard, { props: props({ rows: [] }) })
    expect(wrapper.find('.dash-table').exists()).toBe(false)
    expect(wrapper.find('.dash-hint').exists()).toBe(true)
  })

  it('shows a loading hint while the first snapshot loads', () => {
    const wrapper = mount(Dashboard, { props: props({ rows: [], loading: true }) })
    expect(wrapper.find('.dash-hint').exists()).toBe(true)
    expect(wrapper.find('.dash-table').exists()).toBe(false)
  })

  it('surfaces a refresh-failed banner whose retry emits refresh', async () => {
    const wrapper = mount(Dashboard, { props: props({ refreshFailed: true }) })
    expect(wrapper.find('[data-testid="dash-banner"]').exists()).toBe(true)
    await wrapper.find('[data-testid="dash-retry"]').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })
})
