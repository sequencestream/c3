/**
 * Dashboard.vue coverage: the cross-workspace table, its admin-only per-row
 * automation slide switch (viewers get a read-only badge), and the empty /
 * loading / refresh-failed states. Assertions key off structure / data-testid /
 * emitted events, never visible copy (i18n-spec §4).
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
    pending: new Set<string>(),
    isAdmin: true,
    ...over,
  }
}

describe('Dashboard.vue', () => {
  it('renders one row per workspace', () => {
    const wrapper = mount(Dashboard, { props: props() })
    expect(wrapper.findAll('.dash-table tbody tr')).toHaveLength(2)
  })

  it('shows a per-row switch for an admin and a read-only badge for a viewer', () => {
    const admin = mount(Dashboard, { props: props() })
    expect(admin.findAll('[data-testid="dash-gate-switch"]')).toHaveLength(2)
    expect(admin.findAll('.dash-gate')).toHaveLength(0)

    const viewer = mount(Dashboard, { props: props({ isAdmin: false }) })
    expect(viewer.findAll('[data-testid="dash-gate-switch"]')).toHaveLength(0)
    expect(viewer.findAll('.dash-gate')).toHaveLength(2)
  })

  it('reflects the gate state per row on the switch', () => {
    const wrapper = mount(Dashboard, {
      props: props({
        rows: [row('a', { automationEnabled: true }), row('b', { automationEnabled: false })],
      }),
    })
    const switches = wrapper.findAll('[data-testid="dash-gate-switch"]')
    expect(switches[0].attributes('aria-checked')).toBe('true')
    expect(switches[0].find('.dash-gate-track').classes()).toContain('on')
    expect(switches[1].attributes('aria-checked')).toBe('false')
    expect(switches[1].find('.dash-gate-track').classes()).not.toContain('on')
  })

  it('emits toggle(workspaceId, !enabled) when a row switch is clicked', async () => {
    const wrapper = mount(Dashboard, {
      props: props({
        rows: [row('a', { automationEnabled: true }), row('b', { automationEnabled: false })],
      }),
    })
    const switches = wrapper.findAll('[data-testid="dash-gate-switch"]')
    await switches[0].trigger('click')
    await switches[1].trigger('click')
    expect(wrapper.emitted('toggle')).toEqual([
      ['a', false],
      ['b', true],
    ])
  })

  it('disables a row switch while its toggle is in flight', () => {
    const wrapper = mount(Dashboard, { props: props({ pending: new Set(['a']) }) })
    const switches = wrapper.findAll('[data-testid="dash-gate-switch"]')
    expect(switches[0].attributes('disabled')).toBeDefined()
    expect(switches[1].attributes('disabled')).toBeUndefined()
  })

  it('reflects the gate state per row on the viewer badge', () => {
    const wrapper = mount(Dashboard, {
      props: props({
        isAdmin: false,
        rows: [row('a', { automationEnabled: true }), row('b', { automationEnabled: false })],
      }),
    })
    const gates = wrapper.findAll('.dash-gate')
    expect(gates[0].classes()).toContain('on')
    expect(gates[1].classes()).toContain('off')
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
