import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'

const ws = (id: string, name: string): WorkspaceInfo => ({ id, name, lastAccessed: 0 })
const workspaces = [ws('ws-a', 'proj-a'), ws('ws-b', 'proj-b')]

afterEach(() => vi.unstubAllGlobals())

describe('WorkspaceSwitcher.vue', () => {
  it('触发区显示当前工作区名', () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceId: 'ws-b' },
    })
    expect(w.find('.ws-switcher-name').text()).toBe('proj-b')
  })

  it('无当前工作区 → 显示占位文案', () => {
    const w = mount(WorkspaceSwitcher, { props: { workspaces, currentWorkspaceId: null } })
    expect(w.find('.ws-switcher-name.empty').exists()).toBe(true)
  })

  it('点击 ▾ 展开下拉,列出全部工作区的名称(不再泄露绝对路径)', async () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceId: 'ws-a' },
    })
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)
    await w.find('.ws-switcher-trigger').trigger('click')
    const items = w.findAll('.ws-switcher-item')
    expect(items).toHaveLength(2)
    expect(items[0].find('.ws-switcher-item-name').text()).toBe('proj-a')
    expect(items[1].find('.ws-switcher-item-name').text()).toBe('proj-b')
    // 路径子标题已彻底移除 — 前端拿不到绝对路径。
    expect(items[0].find('.ws-switcher-item-path').exists()).toBe(false)
  })

  it('点选某项 → emit select-workspace(id);当前项不重复 emit', async () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceId: 'ws-a' },
    })
    await w.find('.ws-switcher-trigger').trigger('click')
    const items = w.findAll('.ws-switcher-item')
    await items[1].trigger('click') // 切到 proj-b
    expect(w.emitted('select-workspace')).toEqual([['ws-b']])
    // 选中后下拉关闭
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)

    await w.find('.ws-switcher-trigger').trigger('click')
    await w.findAll('.ws-switcher-item')[0].trigger('click') // 点当前项 proj-a
    expect(w.emitted('select-workspace')).toEqual([['ws-b']]) // 未新增
  })

  it('+ 取到路径 → emit add-workspace(路径仅在此入口出现)', async () => {
    vi.stubGlobal('prompt', () => '  /home/proj-c  ')
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceId: 'ws-a' },
    })
    await w.find('.ws-switcher-add').trigger('click')
    expect(w.emitted('add-workspace')).toEqual([['/home/proj-c']])
  })

  it('+ 取消(返回空)→ 不 emit', async () => {
    vi.stubGlobal('prompt', () => null)
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceId: 'ws-a' },
    })
    await w.find('.ws-switcher-add').trigger('click')
    expect(w.emitted('add-workspace')).toBeUndefined()
  })

  it('✕ 二次确认通过 → emit remove-workspace(id);取消 → 不 emit', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceId: 'ws-a' },
    })
    await w.find('.ws-switcher-trigger').trigger('click')
    await w.findAll('.ws-switcher-remove')[1].trigger('click')
    expect(confirm).toHaveBeenCalledOnce()
    expect(w.emitted('remove-workspace')).toEqual([['ws-b']])

    confirm.mockReturnValue(false)
    await w.findAll('.ws-switcher-remove')[0].trigger('click')
    expect(w.emitted('remove-workspace')).toEqual([['ws-b']]) // 未新增
  })
})
