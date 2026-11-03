import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GlobalBrowserList from './GlobalBrowserList.vue'

describe('global list', () => {
  it('shows ownership and running state, opens only on click, and guards pagination while loading', async () => {
    const wrapper = mount(GlobalBrowserList, {
      props: {
        title: 'Sessions',
        rows: [{ id: 's1', workspaceName: 'alpha', title: 'Fix pagination', running: true }],
        activeId: null,
        hasMore: true,
      },
    })
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.find('.running-dot').attributes('aria-label')).toBeTruthy()
    expect(wrapper.emitted('select')).toBeUndefined()
    await wrapper.find('.global-row').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['s1', 'alpha']])
    await wrapper.find('.load-more').trigger('click')
    expect(wrapper.emitted('more')).toHaveLength(1)
    await wrapper.setProps({ loading: true })
    expect(wrapper.find('.load-more').attributes('disabled')).toBeDefined()
  })
})
