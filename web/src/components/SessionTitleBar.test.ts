import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionTitleBar from './SessionTitleBar.vue'
import BaseDropdown from './BaseDropdown.vue'
import type { PermissionMode } from '@ccc/shared/protocol'

const MODE_OPTIONS = [
  { value: 'default' as PermissionMode, label: 'default' },
  { value: 'plan' as PermissionMode, label: 'plan' },
]

function mountBar(props: Partial<Record<string, unknown>> = {}) {
  return mount(SessionTitleBar, {
    props: {
      activeTitle: 'Alpha',
      mode: 'default' as PermissionMode,
      modeOptions: MODE_OPTIONS,
      ...props,
    },
  })
}

describe('SessionTitleBar.vue — 会话标题行', () => {
  it('左侧渲染会话标题', () => {
    const w = mountBar({ activeTitle: 'My Session' })
    expect(w.find('.session-title-text').text()).toBe('My Session')
  })

  it('右侧渲染权限模式下拉', () => {
    const w = mountBar()
    expect(w.find('.mode').exists()).toBe(true)
    expect(w.findComponent(BaseDropdown).exists()).toBe(true)
  })

  it('切换模式 → emit set-mode(mode)', async () => {
    const w = mountBar()
    await w.find('.dd-trigger').trigger('click')
    const items = w.findAll('.dd-item')
    await items[1].trigger('click') // plan
    expect(w.emitted('set-mode')).toEqual([['plan']])
  })
})
