import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import WorkspaceListRail from './WorkspaceListRail.vue'
import { useAuth } from '@/composables/useAuth'
import { workspaceColor } from '@/lib/workspace-color'
import type { WorkspaceInfo } from '@ccc/shared/protocol'

const ws = (name: string, lastAccessed: number): WorkspaceInfo => ({
  name,
  path: `/home/alice/${name}`,
  lastAccessed,
})

// 故意乱序喂入:服务端本已降序下发,组件那一次防御性排序正是为了这种路径。
const workspaces = [ws('proj-b', 200), ws('proj-a', 300), ws('proj-c', 100)]

const baseProps = {
  workspaces,
  currentWorkspaceName: 'proj-a' as string | null,
  expanded: true,
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
  return mount(WorkspaceListRail, { props: { ...baseProps, ...props } })
}

/** 展开态下每一项渲染的名字,按 DOM 顺序。 */
function expandedNames(w: ReturnType<typeof mountRail>): string[] {
  return w.findAll('[data-testid="ws-list-row"]').map((row) => row.find('.ws-list-name').text())
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAuth().setIsAdmin(true)
})

describe('WorkspaceListRail.vue — 列表与排序', () => {
  it('完整列出全部工作区,一项不落', () => {
    expect(expandedNames(mountRail())).toHaveLength(workspaces.length)
  })

  it('按最近访问时间倒序:刚更新过的排最上(即便传入是乱序)', () => {
    expect(expandedNames(mountRail())).toEqual(['proj-a', 'proj-b', 'proj-c'])
  })

  it('某个工作区被更新(lastAccessed 变大)后重排到顶部', async () => {
    const w = mountRail()
    await w.setProps({
      workspaces: [ws('proj-c', 900), ws('proj-b', 200), ws('proj-a', 300)],
    })
    expect(expandedNames(w)).toEqual(['proj-c', 'proj-a', 'proj-b'])
  })

  it('时间相同则按名称升序,顺序稳定不跳动', () => {
    const w = mountRail({
      workspaces: [ws('proj-c', 5), ws('proj-a', 5), ws('proj-b', 5)],
    })
    expect(expandedNames(w)).toEqual(['proj-a', 'proj-b', 'proj-c'])
  })

  it('空列表 → 渲染空态,不是一片空白', () => {
    const w = mountRail({ workspaces: [] })
    expect(w.find('.ws-list-empty').exists()).toBe(true)
  })
})

describe('WorkspaceListRail.vue — 展开 / 收缩双形态', () => {
  it('展开态:显示名称', () => {
    const w = mountRail()
    expect(w.findAll('.ws-list-name').map((n) => n.text())).toEqual(['proj-a', 'proj-b', 'proj-c'])
  })

  it('收缩态:每项只渲染首字符徽标,名称文本一律不出现', () => {
    const w = mountRail({ expanded: false })
    expect(w.findAll('.ws-list-name')).toHaveLength(0)
    const chips = w.findAll('.ws-list-initial')
    expect(chips).toHaveLength(3)
    expect(chips.map((c) => c.text())).toEqual(['P', 'P', 'P'])
    expect(w.find('.ws-list-rail-collapsed').exists()).toBe(true)
  })

  it('切换控件在两种形态间互切,只上抛意图,自身不改状态', async () => {
    const w = mountRail()
    expect(w.find('[data-testid="ws-list-toggle"]').attributes('aria-expanded')).toBe('true')
    await w.find('[data-testid="ws-list-toggle"]').trigger('click')
    expect(w.emitted('toggle-expanded')).toHaveLength(1)
    // 形态由 App.vue 持有:组件自己仍是展开态,直到父层把新 props 传下来。
    expect(w.findAll('.ws-list-name')).toHaveLength(3)

    await w.setProps({ expanded: false })
    expect(w.find('[data-testid="ws-list-toggle"]').attributes('aria-expanded')).toBe('false')
    await w.find('[data-testid="ws-list-toggle"]').trigger('click')
    expect(w.emitted('toggle-expanded')).toHaveLength(2)
  })

  it('收缩态的列表项可聚焦并能用键盘选中(不能只靠鼠标)', async () => {
    const w = mountRail({ expanded: false })
    const rows = w.findAll('[data-testid="ws-list-row-collapsed"]')
    expect(rows.every((r) => r.attributes('tabindex') === '0')).toBe(true)
    await rows[1]!.trigger('keydown.enter')
    expect(w.emitted('select-workspace')).toEqual([['proj-b']])
  })
})

describe('WorkspaceListRail.vue — 配色与字符徽标', () => {
  it('色槽由名字派生,与竖条入口徽标同源同值', () => {
    const w = mountRail()
    const chips = w.findAll('.ws-list-chip')
    // 与渲染顺序对齐(列表是按最近访问排过的,不是传入顺序)。
    const rendered = expandedNames(w)
    expect(chips.map((c) => c.attributes('data-ws-slot'))).toEqual(
      rendered.map((name) => String(workspaceColor(name)!.slot)),
    )
  })

  it('同一工作区在展开 / 收缩两形态下落到同一色槽', async () => {
    const w = mountRail()
    const expandedSlots = w.findAll('.ws-list-chip').map((c) => c.attributes('data-ws-slot'))
    await w.setProps({ expanded: false })
    const collapsedSlots = w.findAll('.ws-list-chip').map((c) => c.attributes('data-ws-slot'))
    expect(collapsedSlots).toEqual(expandedSlots)
  })

  it('跨刷新稳定:同名字重复求值恒得同一色槽', () => {
    // 组件不持有任何配色状态,重挂载后重算即可复现 —— 这正是「稳定」的来源。
    const first = mountRail()
      .findAll('.ws-list-chip')
      .map((c) => c.attributes('data-ws-slot'))
    vi.unstubAllGlobals()
    const second = mountRail()
      .findAll('.ws-list-chip')
      .map((c) => c.attributes('data-ws-slot'))
    expect(second).toEqual(first)
  })

  it('模板与样式里不出现硬编码色值 —— 底色只由 data-ws-slot 查主题令牌得到', () => {
    const source = readFileSync(resolve(__dirname, 'WorkspaceListRail.vue'), 'utf-8')
    const style = source.slice(source.indexOf('<style scoped>'))
    // 徽标底色只经由 [data-ws-slot='N'] 规则写 var(--c-ws-N),不落具体色值。
    expect(style).toMatch(/background: var\(--c-ws-1\)/)
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(style).not.toMatch(/rgba?\(/)
  })
})

describe('WorkspaceListRail.vue — 选中态', () => {
  it('展开态:当前工作区项带 aria-current 与高亮标记', () => {
    const w = mountRail()
    const current = w.findAll('[data-testid="ws-list-row"]')[0]!
    expect(current.attributes('aria-current')).toBe('true')
    expect(current.classes()).toContain('current')
  })

  it('收缩态:选中态同样可见 —— 不因形态收掉高亮', () => {
    const w = mountRail({ expanded: false })
    const current = w.findAll('[data-testid="ws-list-row-collapsed"]')[0]!
    expect(current.attributes('aria-current')).toBe('true')
    expect(current.classes()).toContain('current')
  })

  it('非当前项不带 aria-current', () => {
    const w = mountRail()
    const others = w.findAll('[data-testid="ws-list-row"]').slice(1)
    expect(others.every((r) => r.attributes('aria-current') === undefined)).toBe(true)
  })

  it('切换工作区后选中态跟随新的当前工作区', async () => {
    const w = mountRail()
    await w.setProps({ currentWorkspaceName: 'proj-c' })
    const rows = w.findAll('[data-testid="ws-list-row"]')
    expect(rows[2]!.attributes('aria-current')).toBe('true')
    expect(rows[0]!.attributes('aria-current')).toBeUndefined()
  })
})

describe('WorkspaceListRail.vue — 切换工作区', () => {
  it('点选某项 → 上抛 select-workspace(name),由控制层完成副作用', async () => {
    const w = mountRail()
    await w.findAll('[data-testid="ws-list-row"]')[1]!.trigger('click')
    expect(w.emitted('select-workspace')).toEqual([['proj-b']])
  })

  it('点选当前工作区不触发切换(与既有切换器行为一致)', async () => {
    const w = mountRail()
    await w.findAll('[data-testid="ws-list-row"]')[0]!.trigger('click')
    expect(w.emitted('select-workspace')).toBeUndefined()
  })
})

describe('WorkspaceListRail.vue — 运行中角标', () => {
  it('按每个工作区自己的计数渲染,与竖条入口同源', () => {
    const w = mountRail({ workspaceRunningSessionCounts: { 'proj-b': 3, 'proj-c': 1 } })
    const badges = w.findAll('[data-testid="ws-list-badge"]')
    expect(badges).toHaveLength(2)
    // proj-b 排在第 2 位、proj-c 排第 3 位。
    expect(badges[0]!.text()).toBe('3')
    expect(badges[1]!.text()).toBe('1')
  })

  it('计数为 0 或缺项 → 不渲染角标(缺项按 0 处理,不猜数)', () => {
    const w = mountRail({ workspaceRunningSessionCounts: { 'proj-b': 0 } })
    expect(w.find('[data-testid="ws-list-badge"]').exists()).toBe(false)
  })

  it('完全没有计数下发时同样不渲染角标', () => {
    expect(mountRail().find('[data-testid="ws-list-badge"]').exists()).toBe(false)
  })

  it('角标带含计数的无障碍文案', () => {
    const w = mountRail({ workspaceRunningSessionCounts: { 'proj-a': 7 } })
    expect(w.find('[data-testid="ws-list-badge"]').attributes('aria-label')).toContain('7')
  })
})

describe('WorkspaceListRail.vue — 管理员增删入口', () => {
  it('「+ 新增」只上抛诉求,自身不持有弹框(实例由 AppHeader 持有)', async () => {
    const w = mountRail()
    await w.find('[data-testid="ws-list-add"]').trigger('click')
    expect(w.emitted('request-add-workspace')).toHaveLength(1)
    expect(w.find('[data-testid="input-overlay"]').exists()).toBe(false)
  })

  it('✕ 弹出 ConfirmDialog(danger),确认 → 上抛 remove-workspace;取消 → 不上抛', async () => {
    const w = mountRail()
    await w.findAll('.ws-list-remove')[1]!.trigger('click')
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(true)
    expect(w.find('[data-testid="confirm-accept"]').classes()).toContain('danger')
    await w.find('[data-testid="confirm-accept"]').trigger('click')
    expect(w.emitted('remove-workspace')).toEqual([['proj-b']])
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)

    await w.findAll('.ws-list-remove')[0]!.trigger('click')
    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    expect(w.emitted('remove-workspace')).toEqual([['proj-b']])
  })

  it('非管理员 → 新增与移除入口都不出现(增删仅管理员)', () => {
    useAuth().setIsAdmin(false)
    const w = mountRail()
    expect(w.find('[data-testid="ws-list-add"]').exists()).toBe(false)
    expect(w.findAll('.ws-list-remove')).toHaveLength(0)
    // 查看 / 切换对任何已认证用户都保持开放。
    expect(w.findAll('[data-testid="ws-list-row"]')).toHaveLength(3)
  })
})

describe('WorkspaceListRail.vue — 窄屏与工作台视图', () => {
  it('窄屏(≤767px)不渲染 —— 移动端沿用 AppHeader 精简行的切换器', () => {
    expect(mountRail({}, 767).find('.ws-list-rail').exists()).toBe(false)
    expect(mountRail({}, 600).find('.ws-list-rail').exists()).toBe(false)
    expect(mountRail({}, 768).find('.ws-list-rail').exists()).toBe(true)
  })

  it('工作台视图下一并隐藏,不与竖条那条「回到工作区」争抢点击', () => {
    expect(mountRail({ viewMode: 'workspace' }).find('.ws-list-rail').exists()).toBe(true)
    expect(mountRail({ viewMode: 'workcenter' }).find('.ws-list-rail').exists()).toBe(false)
  })
})
