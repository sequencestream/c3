import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import { useAuth } from '@/composables/useAuth'
import type { WorkspaceInfo } from '@ccc/shared/protocol'

const ws = (name: string, path: string): WorkspaceInfo => ({
  name,
  path,
  lastAccessed: 0,
})
const workspaces = [
  ws('proj-a', '/home/alice/work/proj-a'),
  ws('proj-b', '/home/alice/other/proj-b'),
]

// `isAdmin` is a module-singleton (defaults true). Restore it after each test so
// the admin-gated cases don't leak into the others.
afterEach(() => {
  vi.unstubAllGlobals()
  useAuth().setIsAdmin(true)
})

describe('WorkspaceSwitcher.vue', () => {
  it('触发区显示当前工作区名', () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceName: 'proj-b' },
    })
    expect(w.find('.ws-switcher-name').text()).toBe('proj-b')
  })

  it('无当前工作区 → 显示占位文案', () => {
    const w = mount(WorkspaceSwitcher, { props: { workspaces, currentWorkspaceName: null } })
    expect(w.find('.ws-switcher-name.empty').exists()).toBe(true)
  })

  it('点击 ▾ 展开下拉,每行显示名称 + 名称下方的完整绝对路径', async () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceName: 'proj-a' },
    })
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)
    await w.find('.ws-switcher-trigger').trigger('click')
    const items = w.findAll('.ws-switcher-item')
    expect(items).toHaveLength(2)
    expect(items[0].find('.ws-switcher-item-name').text()).toBe('proj-a')
    expect(items[1].find('.ws-switcher-item-name').text()).toBe('proj-b')
    // 名称下方以次级行显示完整路径,明确其文件系统位置。
    expect(items[0].find('.ws-switcher-item-path').text()).toBe('/home/alice/work/proj-a')
    expect(items[1].find('.ws-switcher-item-path').text()).toBe('/home/alice/other/proj-b')
  })

  it('点选某项 → emit select-workspace(name);当前项不重复 emit', async () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceName: 'proj-a' },
    })
    await w.find('.ws-switcher-trigger').trigger('click')
    const items = w.findAll('.ws-switcher-item')
    await items[1].trigger('click') // 切到 proj-b
    expect(w.emitted('select-workspace')).toEqual([['proj-b']])
    // 选中后下拉关闭
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)

    await w.find('.ws-switcher-trigger').trigger('click')
    await w.findAll('.ws-switcher-item')[0].trigger('click') // 点当前项 proj-a
    expect(w.emitted('select-workspace')).toEqual([['proj-b']]) // 未新增
  })

  it('+ 只上抛新增诉求,自身不持有弹框(实例由顶栏单独持有)', async () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceName: 'proj-a' },
    })
    await w.find('.ws-switcher-add').trigger('click')
    expect(w.emitted('request-add-workspace')).toHaveLength(1)
    expect(w.find('[data-testid="input-overlay"]').exists()).toBe(false)
  })

  it('✕ 弹出 ConfirmDialog(danger),确认 → emit remove-workspace(name);取消 → 不 emit', async () => {
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceName: 'proj-a' },
    })
    await w.find('.ws-switcher-trigger').trigger('click')
    // 点 ✕ 弹出 ConfirmDialog
    await w.findAll('.ws-switcher-remove')[1].trigger('click')
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(true)
    expect(w.find('[data-testid="confirm-accept"]').classes()).toContain('danger')
    // 确认 → emit
    await w.find('[data-testid="confirm-accept"]').trigger('click')
    expect(w.emitted('remove-workspace')).toEqual([['proj-b']])
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)

    // 再点另一项 → 取消 → 不新增 emit
    await w.findAll('.ws-switcher-remove')[0].trigger('click')
    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    expect(w.emitted('remove-workspace')).toEqual([['proj-b']]) // 未新增
  })

  it('非管理员 → 隐藏「+ 新增」与「✕ 移除」入口(增删仅管理员)', async () => {
    useAuth().setIsAdmin(false)
    const w = mount(WorkspaceSwitcher, {
      props: { workspaces, currentWorkspaceName: 'proj-a' },
    })
    // 新增入口消失
    expect(w.find('.ws-switcher-add').exists()).toBe(false)
    // 展开下拉仍可查看/切换,但每行的移除按钮消失
    await w.find('.ws-switcher-trigger').trigger('click')
    expect(w.findAll('.ws-switcher-item')).toHaveLength(2)
    expect(w.findAll('.ws-switcher-remove')).toHaveLength(0)
  })
})
