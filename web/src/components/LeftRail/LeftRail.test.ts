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

// 工作区入口不再自己持有列表:它的职责收敛为「开合左侧的工作区列表竖条」。列表本身
// 见 WorkspaceListRail.test.ts,这里只钉住竖条这一侧的契约。
describe('LeftRail.vue — 工作区入口开合列表竖条', () => {
  it('点工作区入口 → 上抛开合意图,由 App.vue 持有列表竖条的显隐', async () => {
    const w = mountRail()
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)
    await w.find('[data-testid="rail-workspace-open"]').trigger('click')
    expect(w.emitted('toggle-workspace-list')).toHaveLength(1)
  })

  it('竖条自身不再持有任何工作区列表 —— 列表竖条接替了浮层下拉的职责', () => {
    const w = mountRail()
    // 点开也不该冒出 popover:两份工作区列表并存正是这次要消除的问题。
    w.find('[data-testid="rail-workspace-open"]').trigger('click')
    expect(w.find('.ws-switcher-panel').exists()).toBe(false)
    expect(w.find('.ws-switcher').exists()).toBe(false)
  })

  it('入口把列表竖条的显隐播报给无障碍层,并指向那条列表', async () => {
    const closed = mountRail()
    const btn = closed.find('[data-testid="rail-workspace-open"]')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(btn.attributes('aria-controls')).toBe('ws-list-rail')
    await closed.setProps({ workspaceListOpen: true })
    expect(closed.find('[data-testid="rail-workspace-open"]').attributes('aria-expanded')).toBe(
      'true',
    )
  })

  it('入口不再上抛切换/增删:那些动作都在列表竖条里', async () => {
    const w = mountRail()
    await w.find('[data-testid="rail-workspace-open"]').trigger('click')
    expect(w.emitted('select-workspace')).toBeUndefined()
    expect(w.emitted('request-add-workspace')).toBeUndefined()
    expect(w.emitted('remove-workspace')).toBeUndefined()
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
  it('工作区视图:工作区入口是开合列表竖条,不渲染回落按钮', () => {
    const w = mountRail({ viewMode: 'workspace' })
    expect(w.find('[data-testid="rail-workspace-open"]').exists()).toBe(true)
    expect(w.find('[data-testid="rail-workspace-back"]').exists()).toBe(false)
  })

  it('工作台视图:工作区入口换成回落按钮,不再开合列表竖条', () => {
    const w = mountRail({ viewMode: 'workcenter' })
    expect(w.find('[data-testid="rail-workspace-open"]').exists()).toBe(false)
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
