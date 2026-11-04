import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GlobalBrowserList from './GlobalBrowserList.vue'

const rows = ['alpha', 'beta'].flatMap((workspaceName) =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `${workspaceName}-${i}`,
    workspaceName,
    title: `Task ${i}`,
    running: i === 0,
  })),
)

describe('global grouped list', () => {
  it('toggles workspace folders independently and preserves loaded rows and selection', async () => {
    const wrapper = mount(GlobalBrowserList, {
      props: { title: 'Sessions', rows, activeId: 'alpha-0', activeWorkspace: 'alpha' },
    })
    const groups = wrapper.findAll('.workspace-group')
    const toggle = groups[0].get('.workspace-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(groups[0].find('.workspace-folder.open').exists()).toBe(true)
    const openPath = groups[0].get('.workspace-folder').html()
    await groups[0].get('.load-more').trigger('click')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(groups[0].find('.workspace-folder.open').exists()).toBe(false)
    expect(groups[0].get('.workspace-folder').html()).not.toBe(openPath)
    expect(groups[0].find('.workspace-children').exists()).toBe(false)
    expect(groups[1].findAll('.global-row')).toHaveLength(5)
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.emitted('more')).toBeUndefined()
    await toggle.trigger('click')
    expect(groups[0].findAll('.workspace-children .global-row')).toHaveLength(10)
    expect(groups[0].get('.global-row.selected').text()).toBe('Task 0')
    expect(groups[0].find('.workspace-folder.open').exists()).toBe(true)
  })

  it('shows five automations per workspace and expands each group independently', async () => {
    const wrapper = mount(GlobalBrowserList, {
      props: { title: 'Automations', rows, activeId: null },
    })
    const groups = wrapper.findAll('.workspace-group')
    expect(groups.map((group) => group.get('h3').text())).toEqual(['alpha', 'beta'])
    expect(groups.map((group) => group.findAll('.global-row').length)).toEqual([5, 5])
    await groups[0].get('.load-more').trigger('click')
    expect(groups.map((group) => group.findAll('.global-row').length)).toEqual([10, 5])
    await groups[0].get('.load-more').trigger('click')
    expect(groups[0].findAll('.global-row')).toHaveLength(12)
    expect(groups[0].find('.load-more').exists()).toBe(false)
    expect(groups[1].findAll('.global-row')).toHaveLength(5)
    expect(wrapper.emitted('select')).toBeUndefined()
    await groups[1].get('.global-row').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['beta-0', 'beta']])
    expect(groups[1].get('.running-dot').attributes('aria-label')).toBeTruthy()
  })

  it('requests only the selected session group and keeps other groups usable while loading', async () => {
    const wrapper = mount(GlobalBrowserList, {
      props: {
        title: 'Sessions',
        rows: rows.filter((row) => Number(row.id.split('-')[1]) < 5),
        activeId: null,
        paging: {
          alpha: { hasMore: true, loading: true, failed: false },
          beta: { hasMore: true, loading: false, failed: false },
        },
      },
    })
    const groups = wrapper.findAll('.workspace-group')
    expect(groups[0].get('.load-more').attributes('disabled')).toBeDefined()
    expect(groups[1].get('.load-more').attributes('disabled')).toBeUndefined()
    await groups[1].get('.load-more').trigger('click')
    expect(wrapper.emitted('more')).toEqual([['beta']])
    await wrapper.setProps({
      paging: {
        alpha: { hasMore: true, loading: false, failed: true },
        beta: { hasMore: false, loading: false, failed: false },
      },
    })
    expect(groups[0].find('[role="alert"]').exists()).toBe(true)
    await groups[0].get('.load-more').trigger('click')
    expect(wrapper.emitted('more')).toEqual([['beta'], ['alpha']])
    expect(groups[1].find('.load-more').exists()).toBe(false)
  })
})
