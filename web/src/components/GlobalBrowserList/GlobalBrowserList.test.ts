import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
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
  it('creates a work session in the named workspace without toggling its folder', async () => {
    const wrapper = mount(GlobalBrowserList, {
      props: { title: 'Sessions', rows, activeId: null, canCreateSession: true },
    })
    const groups = wrapper.findAll('.workspace-group')
    await groups[1].get('.workspace-toggle').trigger('click')
    await groups[1].get('.workspace-new-session').trigger('click')
    expect(wrapper.emitted('create-session')).toEqual([['beta']])
    expect(groups[1].get('.workspace-toggle').attributes('aria-expanded')).toBe('false')
    expect(wrapper.emitted('select')).toBeUndefined()
    await wrapper.setProps({ canCreateSession: false })
    expect(wrapper.find('.workspace-new-session').exists()).toBe(false)
    wrapper.unmount()
  })

  it('orders workspaces by their newest session and reorders without losing folder state', async () => {
    const wrapper = mount(GlobalBrowserList, {
      props: {
        title: 'Sessions',
        rows: [
          { ...rows[0], lastModified: 100 },
          { ...rows[1], lastModified: 300 },
          { ...rows[12], lastModified: 200 },
        ],
        activeId: 'beta-0',
        paging: {
          empty: { hasMore: false, loading: false, failed: false },
          beta: { hasMore: false, loading: false, failed: false },
          alpha: { hasMore: true, loading: false, failed: false },
        },
      },
    })
    const names = (): string[] => wrapper.findAll('.workspace-group h3').map((node) => node.text())
    expect(names()).toEqual(['alpha', 'beta', 'empty'])
    await wrapper.findAll('.workspace-toggle')[0].trigger('click')
    await wrapper.setProps({ rows: [...wrapper.props('rows'), { ...rows[13], lastModified: 400 }] })
    expect(names()).toEqual(['beta', 'alpha', 'empty'])
    const groups = wrapper.findAll('.workspace-group')
    expect(groups[0].get('.global-row.selected').text()).toBe('Task 0')
    expect(groups[1].get('.workspace-toggle').attributes('aria-expanded')).toBe('false')
    expect(wrapper.emitted('select')).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps both panes within percentage limits when dragging at different container sizes', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let width = 1006
    const wrapper = mount(GlobalBrowserList, {
      attachTo: host,
      props: { title: 'Sessions', rows, activeId: null },
    })
    vi.spyOn(
      wrapper.get('.global-list').element.parentElement!,
      'getBoundingClientRect',
    ).mockImplementation(() => ({ width }) as DOMRect)
    const splitter = wrapper.get('[role="separator"]')
    const move = async (clientX: number): Promise<void> => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX, pointerId: 1 }))
      await nextTick()
    }
    await splitter.trigger('pointerdown', { clientX: 300, pointerId: 1, button: 0 })
    await move(-2000)
    expect(splitter.attributes('aria-valuenow')).toBe('15')
    await move(2000)
    expect(splitter.attributes('aria-valuenow')).toBe('60')
    await move(400)
    expect(splitter.attributes('aria-valuenow')).toBe('40')
    width = 506
    await move(400)
    expect(splitter.attributes('aria-valuenow')).toBe('50')
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    await move(-2000)
    expect(splitter.attributes('aria-valuenow')).toBe('50')
    expect(wrapper.get('.global-list').attributes('style')).toContain('50%')
    wrapper.unmount()
    host.remove()
  })

  it('constrains keyboard resizing and removes drag listeners when unmounted', async () => {
    const wrapper = mount(GlobalBrowserList, {
      props: { title: 'Automations', rows, activeId: null },
    })
    const splitter = wrapper.get('[role="separator"]')
    expect(splitter.attributes('aria-valuenow')).toBe('30')
    await splitter.trigger('keydown', { key: 'Home' })
    await splitter.trigger('keydown', { key: 'ArrowLeft' })
    expect(splitter.attributes('aria-valuenow')).toBe('15')
    await splitter.trigger('keydown', { key: 'ArrowRight' })
    expect(splitter.attributes('aria-valuenow')).toBe('17')
    await splitter.trigger('keydown', { key: 'End' })
    await splitter.trigger('keydown', { key: 'ArrowRight' })
    expect(splitter.attributes('aria-valuenow')).toBe('60')
    await splitter.trigger('pointerdown', { clientX: 300, pointerId: 1, button: 0 })
    const removeListener = vi.spyOn(window, 'removeEventListener')
    wrapper.unmount()
    expect(removeListener).toHaveBeenCalledWith('pointermove', expect.any(Function))
    removeListener.mockRestore()
  })

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

  it('emits request-add-workspace for admins only', async () => {
    const wrapper = mount(GlobalBrowserList, {
      props: { title: 'Sessions', rows, activeId: null, isAdmin: true },
    })
    await wrapper.get('[data-testid="global-add-workspace"]').trigger('click')
    expect(wrapper.emitted('request-add-workspace')).toEqual([[]])
    await wrapper.setProps({ isAdmin: false })
    expect(wrapper.find('[data-testid="global-add-workspace"]').exists()).toBe(false)
    wrapper.unmount()
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
