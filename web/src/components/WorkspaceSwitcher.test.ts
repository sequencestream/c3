import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'

const ws = (path: string, name: string): WorkspaceInfo => ({ path, name, lastAccessed: 0 })
const workspaces = [ws('/home/proj-a', 'proj-a'), ws('/home/proj-b', 'proj-b')]

afterEach(() => vi.unstubAllGlobals())

describe('WorkspaceSwitcher.vue', () => {
  it('触发区显示当前工作区名', () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspace: '/home/proj-b' },
    })
    expect(w.find('.ws-switcher-name').text()).toBe('proj-b')
  })

  it('无当前工作区 → 显示占位文案', () => {
    const w = mount(WorkspaceSwitcher, { props: { workspaces, currentWorkspace: null } })
    expect(w.find('.ws-switcher-name.empty').exists()).toBe(true)
  })

  it('点击 ▾ 展开下拉,列出全部工作区的名称与路径', async () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspace: '/home/proj-a' },
    })
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)
    await w.find('.ws-switcher-trigger').trigger('click')
    const items = w.findAll('.ws-switcher-item')
    expect(items).toHaveLength(2)
    expect(items[0].find('.ws-switcher-item-name').text()).toBe('proj-a')
    expect(items[0].find('.ws-switcher-item-path').text()).toBe('/home/proj-a')
    expect(items[1].find('.ws-switcher-item-path').text()).toBe('/home/proj-b')
  })

  it('点选某项 → emit select-workspace;当前项不重复 emit', async () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspace: '/home/proj-a' },
    })
    await w.find('.ws-switcher-trigger').trigger('click')
    const items = w.findAll('.ws-switcher-item')
    await items[1].trigger('click') // 切到 proj-b
    expect(w.emitted('select-workspace')).toEqual([['/home/proj-b']])
    // 选中后下拉关闭
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)

    await w.find('.ws-switcher-trigger').trigger('click')
    await w.findAll('.ws-switcher-item')[0].trigger('click') // 点当前项 proj-a
    expect(w.emitted('select-workspace')).toEqual([['/home/proj-b']]) // 未新增
  })

  it('+ 取到路径 → emit add-workspace', async () => {
    vi.stubGlobal('prompt', () => '  /home/proj-c  ')
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspace: '/home/proj-a' },
    })
    await w.find('.ws-switcher-add').trigger('click')
    expect(w.emitted('add-workspace')).toEqual([['/home/proj-c']])
  })

  it('+ 取消(返回空)→ 不 emit', async () => {
    vi.stubGlobal('prompt', () => null)
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspace: '/home/proj-a' },
    })
    await w.find('.ws-switcher-add').trigger('click')
    expect(w.emitted('add-workspace')).toBeUndefined()
  })

  it('✕ 二次确认通过 → emit remove-workspace;取消 → 不 emit', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspace: '/home/proj-a' },
    })
    await w.find('.ws-switcher-trigger').trigger('click')
    await w.findAll('.ws-switcher-remove')[1].trigger('click')
    expect(confirm).toHaveBeenCalledOnce()
    expect(w.emitted('remove-workspace')).toEqual([['/home/proj-b']])

    confirm.mockReturnValue(false)
    await w.findAll('.ws-switcher-remove')[0].trigger('click')
    expect(w.emitted('remove-workspace')).toEqual([['/home/proj-b']]) // 未新增
  })
})
