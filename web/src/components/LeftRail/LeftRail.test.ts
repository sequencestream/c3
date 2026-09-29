import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import LeftRail from './LeftRail.vue'
import { useAuth } from '@/composables/useAuth'
import { BREAKPOINT_QUERIES } from '@/composables/useBreakpoint'
import { workspaceColor } from '@/lib/workspace-color'
import type { WorkspaceInfo } from '@ccc/shared/protocol'

const ws = (name: string, path: string): WorkspaceInfo => ({ name, path, lastAccessed: 0 })
const workspaces = [
  ws('proj-a', '/home/alice/work/proj-a'),
  ws('proj-b', '/home/alice/other/proj-b'),
]

const baseProps = {
  workspaces,
  currentWorkspaceName: 'proj-a' as string | null,
}

/** happy-dom has no matchMedia, so the breakpoint query would be unreachable. */
function stubViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const max = /max-width:\s*(\d+)px/.exec(query)?.[1]
    const min = /min-width:\s*(\d+)px/.exec(query)?.[1]
    const matches =
      (max === undefined || width <= Number(max)) && (min === undefined || width >= Number(min))
    return {
      matches,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as MediaQueryList
  })
}

function mountRail(props: Record<string, unknown> = {}, width = 1280) {
  stubViewport(width)
  return mount(LeftRail, { props: { ...baseProps, ...props } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAuth().setIsAdmin(true)
})

describe('LeftRail.vue — 常驻竖条的两枚入口', () => {
  it('渲染工作区入口与用户消息入口,以及各自的角标位', () => {
    const w = mountRail({
      workspaceRunningSessionCounts: { 'proj-a': 3 },
      workcenterPendingCount: 2,
    })
    expect(w.find('.left-rail').exists()).toBe(true)
    expect(w.find('.rail-workspace-chip').exists()).toBe(true)
    expect(w.find('[data-testid="rail-messages"]').exists()).toBe(true)
    expect(w.find('[data-testid="rail-workspace-badge"]').text()).toBe('3')
    expect(w.find('[data-testid="rail-messages-badge"]').text()).toBe('2')
  })

  it('窄屏不渲染竖条 —— 移动端沿用 AppHeader 精简行的入口', () => {
    const w = mountRail({}, 600)
    expect(w.find('.left-rail').exists()).toBe(false)
  })
})

describe('LeftRail.vue — 工作区入口角标取自该工作区的运行中会话数', () => {
  it('只读当前工作区自己的计数,不是全部工作区之和', () => {
    const w = mountRail({
      currentWorkspaceName: 'proj-b',
      workspaceRunningSessionCounts: { 'proj-a': 5, 'proj-b': 1 },
    })
    expect(w.find('[data-testid="rail-workspace-badge"]').text()).toBe('1')
  })

  it('缺项按 0 处理:不为覆盖不到的工作区猜数,直接不显示角标', () => {
    const w = mountRail({ workspaceRunningSessionCounts: { 'proj-a': 0 } })
    expect(w.find('[data-testid="rail-workspace-badge"]').exists()).toBe(false)
  })

  it('完全没有计数下发时同样不显示角标', () => {
    const w = mountRail()
    expect(w.find('[data-testid="rail-workspace-badge"]').exists()).toBe(false)
  })

  it('会话全部结束(计数归零)→ 角标消失,徽标仍在', async () => {
    const w = mountRail({ workspaceRunningSessionCounts: { 'proj-a': 4 } })
    expect(w.find('[data-testid="rail-workspace-badge"]').text()).toBe('4')
    await w.setProps({ workspaceRunningSessionCounts: { 'proj-a': 0 } })
    expect(w.find('[data-testid="rail-workspace-badge"]').exists()).toBe(false)
    expect(w.find('.rail-workspace-chip').exists()).toBe(true)
  })

  it('新开会话让计数上升 → 角标实时跟着变,无需重挂载', async () => {
    const w = mountRail({ workspaceRunningSessionCounts: { 'proj-a': 0 } })
    expect(w.find('[data-testid="rail-workspace-badge"]').exists()).toBe(false)
    await w.setProps({ workspaceRunningSessionCounts: { 'proj-a': 1 } })
    expect(w.find('[data-testid="rail-workspace-badge"]').text()).toBe('1')
  })

  it('角标带含计数的无障碍文案', () => {
    const w = mountRail({ workspaceRunningSessionCounts: { 'proj-a': 7 } })
    expect(w.find('[data-testid="rail-workspace-badge"]').attributes('aria-label')).toContain('7')
  })

  it('无当前工作区 → 徽标显示空占位,且不渲染角标', () => {
    const w = mountRail({
      currentWorkspaceName: null,
      workspaceRunningSessionCounts: { 'proj-a': 3 },
    })
    expect(w.find('.rail-workspace-initial.empty').exists()).toBe(true)
    expect(w.find('[data-testid="rail-workspace-badge"]').exists()).toBe(false)
  })
})

describe('LeftRail.vue — 工作区入口展示当前工作区名首字符与稳定配色', () => {
  it('徽标字母取自工作区名', () => {
    const w = mountRail({ currentWorkspaceName: 'proj-b' })
    expect(w.find('.rail-workspace-initial').text()).toBe('P')
  })

  it('配色由名字派生:徽标落到的色槽与纯函数一致,同名恒定同槽', () => {
    const a = mountRail({ currentWorkspaceName: 'proj-a' })
    const b = mountRail({ currentWorkspaceName: 'proj-a' })
    const slot = workspaceColor('proj-a')!.slot
    expect(a.find('.rail-workspace-chip').attributes('data-ws-slot')).toBe(String(slot))
    expect(a.find('.rail-workspace-chip').attributes('data-ws-slot')).toBe(
      b.find('.rail-workspace-chip').attributes('data-ws-slot'),
    )
  })

  it('无当前工作区 → 不带派生配色,回落到中性底', () => {
    const w = mountRail({ currentWorkspaceName: null })
    expect(w.find('.rail-workspace-chip').attributes('data-ws-slot')).toBeUndefined()
  })
})

describe('LeftRail.vue — 切换工作区', () => {
  it('点工作区入口打开选择器,列表列出全部工作区', async () => {
    const w = mountRail()
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)
    await w.find('.ws-switcher-rail .ws-switcher-trigger-rail').trigger('click')
    expect(w.findAll('.ws-switcher-item').length).toBeGreaterThanOrEqual(2)
  })

  it('选中另一个工作区 → 上抛切换,由控制层完成落 tab / 刷新', async () => {
    const w = mountRail()
    await w.find('.ws-switcher-rail .ws-switcher-trigger-rail').trigger('click')
    const target = w.findAll('.ws-switcher-item').find((item) => item.text().includes('proj-b'))!
    await target.trigger('click')
    expect(w.emitted('select-workspace')).toEqual([['proj-b']])
  })

  it('点选当前工作区不触发切换(与既有切换器行为一致)', async () => {
    const w = mountRail({ currentWorkspaceName: 'proj-a' })
    await w.find('.ws-switcher-rail .ws-switcher-trigger-rail').trigger('click')
    const current = w.findAll('.ws-switcher-item').find((item) => item.text().includes('proj-a'))!
    await current.trigger('click')
    expect(w.emitted('select-workspace')).toBeUndefined()
  })

  it('竖条形态不摆独立「+」按钮,新增入口收进列表且只上抛诉求', async () => {
    useAuth().setIsAdmin(true)
    const w = mountRail()
    expect(w.find('.ws-switcher-rail .ws-switcher-add').exists()).toBe(false)
    await w.find('.ws-switcher-rail .ws-switcher-trigger-rail').trigger('click')
    await w.find('.ws-switcher-add-row-btn').trigger('click')
    expect(w.emitted('request-add-workspace')).toHaveLength(1)
  })
})

describe('LeftRail.vue — 用户消息入口', () => {
  it('点击 → 上抛「进入 workcenter 并定位用户通知」', async () => {
    const w = mountRail()
    await w.find('[data-testid="rail-messages"]').trigger('click')
    expect(w.emitted('open-notifications')).toHaveLength(1)
  })

  it('待处理数归零 → 角标消失', async () => {
    const w = mountRail({ workcenterPendingCount: 5 })
    expect(w.find('[data-testid="rail-messages-badge"]').text()).toBe('5')
    await w.setProps({ workcenterPendingCount: 0 })
    expect(w.find('[data-testid="rail-messages-badge"]').exists()).toBe(false)
  })

  it('待处理数缺省 → 不渲染角标', () => {
    const w = mountRail()
    expect(w.find('[data-testid="rail-messages-badge"]').exists()).toBe(false)
  })

  it('角标带含计数的无障碍文案', () => {
    const w = mountRail({ workcenterPendingCount: 9 })
    expect(w.find('[data-testid="rail-messages-badge"]').attributes('aria-label')).toContain('9')
  })
})

describe('LeftRail.vue — 窄屏断点口径', () => {
  it('与既有移动端断点一致(767px 及以下无竖条)', () => {
    expect(BREAKPOINT_QUERIES.mobile).toBe('(max-width: 767px)')
    expect(mountRail({}, 767).find('.left-rail').exists()).toBe(false)
    expect(mountRail({}, 768).find('.left-rail').exists()).toBe(true)
  })
})

describe('LeftRail.vue — 工作台视图下的「回到工作区」回落入口', () => {
  // 桌面顶栏的旧 viewMode 切换按钮已移除,工作台视图若没有这条回落路径就回不去了。
  it('工作区视图:工作区入口仍是打开切换器,不渲染回落按钮', () => {
    const w = mountRail({ viewMode: 'workspace' })
    expect(w.find('.ws-switcher').exists()).toBe(true)
    expect(w.find('[data-testid="rail-workspace-back"]').exists()).toBe(false)
  })

  it('工作台视图:工作区入口换成回落按钮,切换器不再渲染', () => {
    const w = mountRail({ viewMode: 'workcenter' })
    expect(w.find('.ws-switcher').exists()).toBe(false)
    expect(w.find('[data-testid="rail-workspace-back"]').exists()).toBe(true)
  })

  it('点击回落按钮 → emit enter-workspace(竖条自身不写 viewMode,只上抛)', async () => {
    const w = mountRail({ viewMode: 'workcenter' })
    await w.find('[data-testid="rail-workspace-back"]').trigger('click')
    expect(w.emitted('enter-workspace')).toHaveLength(1)
  })

  it('回落按钮沿用当前工作区徽标与配色,便于识别将回到哪个工作区', () => {
    const w = mountRail({ viewMode: 'workcenter', currentWorkspaceName: 'proj-b' })
    const chip = w.find('[data-testid="rail-workspace-back"] .rail-workspace-chip')
    expect(chip.find('.rail-workspace-initial').text()).toBe('P')
    expect(chip.attributes('data-ws-slot')).toBe(String(workspaceColor('proj-b')!.slot))
  })

  it('用户消息入口在两个视图下都在 —— 与工作区入口构成一对可来回切', () => {
    expect(
      mountRail({ viewMode: 'workspace' }).find('[data-testid="rail-messages"]').exists(),
    ).toBe(true)
    expect(
      mountRail({ viewMode: 'workcenter' }).find('[data-testid="rail-messages"]').exists(),
    ).toBe(true)
  })
})
