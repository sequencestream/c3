import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import LeftRail from './LeftRail.vue'
import { useAuth } from '@/composables/useAuth'
import { BREAKPOINT_QUERIES } from '@/composables/useBreakpoint'

function stubViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const max = /max-width:\s*(\d+)px/.exec(query)?.[1]
    const min = /min-width:\s*(\d+)px/.exec(query)?.[1]
    return {
      matches:
        (max === undefined || width <= Number(max)) && (min === undefined || width >= Number(min)),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as MediaQueryList
  })
}

const baseProps = {
  status: 'open' as const,
  viewMode: 'workspace' as const,
  workcenterPage: 'notifications' as const,
}

function mountRail(props: Record<string, unknown> = {}, width = 1280) {
  stubViewport(width)
  return mount(LeftRail, { props: { ...baseProps, ...props } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAuth().setIsAdmin(true)
  useAuth().setSubject(null)
})

describe('LeftRail.vue — 系统页面导航', () => {
  it('用户通知、总览和聊天机器人各自拥有独立图标入口', () => {
    const wrapper = mountRail()
    expect(wrapper.find('[data-testid="rail-notifications"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rail-dashboard"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rail-robots"]').exists()).toBe(true)
  })

  it.each([
    ['rail-notifications', 'notifications'],
    ['rail-dashboard', 'dashboard'],
    ['rail-robots', 'robots'],
  ] as const)('点击 %s 上抛对应工作台页面 %s', async (testId, page) => {
    const wrapper = mountRail()
    await wrapper.find(`[data-testid="${testId}"]`).trigger('click')
    expect(wrapper.emitted('select-workcenter-page')).toEqual([[page]])
  })

  it('当前工作台页面图标高亮，工作区入口可返回工作区视图', async () => {
    const wrapper = mountRail({ viewMode: 'workcenter', workcenterPage: 'dashboard' })
    expect(wrapper.find('[data-testid="rail-dashboard"]').classes()).toContain('active')
    await wrapper.find('[data-testid="rail-workspace"]').trigger('click')
    expect(wrapper.emitted('enter-workspace')).toHaveLength(1)
  })

  it('通知角标只在待处理数大于零时展示', async () => {
    const wrapper = mountRail({ workcenterPendingCount: 3 })
    expect(wrapper.find('[data-testid="rail-notifications-badge"]').text()).toBe('3')
    await wrapper.setProps({ workcenterPendingCount: 0 })
    expect(wrapper.find('[data-testid="rail-notifications-badge"]').exists()).toBe(false)
  })
})

describe('LeftRail.vue — 底部工具', () => {
  it('状态、个人设置与系统设置在底部工具区，Workspace 设置不在左栏', () => {
    const wrapper = mountRail()
    expect(wrapper.find('.rail-utilities [data-testid="rail-logs-link"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="rail-workspace-setting"]').exists()).toBe(false)
    expect(wrapper.find('.rail-utilities [data-testid="rail-personalized-setting"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('.rail-utilities [data-testid="rail-settings"]').exists()).toBe(true)
  })

  it('打开个人化设置时高亮个人化入口并取消工作区高亮', () => {
    const wrapper = mountRail({ personalizedSettingOpen: true })
    expect(wrapper.find('[data-testid="rail-personalized-setting"]').classes()).toContain('active')
    expect(wrapper.find('[data-testid="rail-workspace"]').classes()).not.toContain('active')
  })

  it('已登录时显示账户图标、登录名和登出动作', async () => {
    useAuth().setSubject('alice')
    const wrapper = mountRail({ showLogout: true })
    expect(wrapper.find('[data-testid="rail-account"]').exists()).toBe(true)
    expect(wrapper.find('.rail-account-name').text()).toBe('alice')
    await wrapper.find('.rail-popover-action').trigger('click')
    expect(wrapper.emitted('logout')).toHaveLength(1)
  })

  it('非管理员隐藏系统设置入口', () => {
    useAuth().setIsAdmin(false)
    expect(mountRail().find('[data-testid="rail-settings"]').exists()).toBe(false)
  })

  it('有升级信息时显示升级图标，无升级时不显示', () => {
    const available = mountRail({
      updateStatus: { available: true, currentVersion: '1.0.0', latestVersion: '1.1.0' },
    })
    expect(available.find('[data-testid="rail-update-link"]').exists()).toBe(true)
    expect(mountRail().find('[data-testid="rail-update-link"]').exists()).toBe(false)
  })

  it('可自更新时点击升级图标上抛下载动作', async () => {
    const wrapper = mountRail({
      updateStatus: { available: true, currentVersion: '1.0.0', latestVersion: '1.1.0' },
      selfUpdate: {
        capable: true,
        phase: 'idle',
        targetVersion: null,
        downloadedBytes: 0,
        totalBytes: 0,
        error: null,
      },
    })
    await wrapper.find('[data-testid="rail-update-action"]').trigger('click')
    expect(wrapper.emitted('start-self-update')).toHaveLength(1)
  })

  it('升级入口两种形态都带高亮类，下载失败时切到错误态类', () => {
    const status = { available: true, currentVersion: '1.0.0', latestVersion: '1.1.0' }
    const capable = {
      capable: true,
      phase: 'idle',
      targetVersion: null,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
    }
    expect(
      mountRail({ updateStatus: status }).find('[data-testid="rail-update-link"]').classes(),
    ).toContain('rail-update')
    const action = mountRail({ updateStatus: status, selfUpdate: capable }).find(
      '[data-testid="rail-update-action"]',
    )
    expect(action.classes()).toContain('rail-update')
    expect(action.classes()).not.toContain('rail-update-error')
    const failed = mountRail({
      updateStatus: status,
      selfUpdate: { ...capable, phase: 'failed' },
    }).find('[data-testid="rail-update-action"]')
    expect(failed.classes()).toContain('rail-update-error')
  })
})

describe('LeftRail.vue — 响应式边界', () => {
  it('767px 及以下不渲染，移动端继续使用精简顶栏', () => {
    expect(BREAKPOINT_QUERIES.mobile).toBe('(max-width: 767px)')
    expect(mountRail({}, 767).find('.left-rail').exists()).toBe(false)
    expect(mountRail({}, 768).find('.left-rail').exists()).toBe(true)
  })
})
