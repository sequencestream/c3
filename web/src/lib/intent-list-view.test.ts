import { describe, it, expect } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import type { CompletionOrderInput } from './intent-list-view'
import type { IntentActionInput } from './intent-list-view'
import {
  compareByCompletion,
  formatDate,
  formatDependsOn,
  hasDependencyBlockingSpecSession,
  isIntentOnWorkspaceMainBranch,
  panelToggleLabel,
  reqRunStatusLabel,
  rowVisibility,
  showRunStatus,
  sliceTerminated,
  statusLabel,
  TERMINAL_PAGE_SIZE,
  visibleIntentActions,
} from './intent-list-view'

describe('hasDependencyBlockingSpecSession', () => {
  it('blocks unfinished and unmerged feature dependencies only in worktree mode', () => {
    const target = { id: 'target', dependsOn: ['dep'] } as Intent
    const dep = { id: 'dep', status: 'todo', branchName: null, prStatus: null } as Intent
    expect(hasDependencyBlockingSpecSession(target, [dep], 'worktree', 'main')).toBe(true)
    expect(hasDependencyBlockingSpecSession(target, [dep], 'current-branch', 'main')).toBe(false)
    expect(
      hasDependencyBlockingSpecSession(
        target,
        [{ ...dep, status: 'done', branchName: 'feature/x' }],
        'worktree',
        'main',
      ),
    ).toBe(true)
    expect(
      hasDependencyBlockingSpecSession(
        target,
        [{ ...dep, status: 'done', prStatus: 'merged' }],
        'worktree',
        'main',
      ),
    ).toBe(false)
  })
})

describe('statusLabel', () => {
  it('七种状态各映射到对应英文标签', () => {
    expect(statusLabel('draft')).toBe('Draft')
    expect(statusLabel('todo')).toBe('To do')
    expect(statusLabel('in_progress')).toBe('In progress')
    expect(statusLabel('done')).toBe('Done')
    expect(statusLabel('cancelled')).toBe('Cancelled')
    expect(statusLabel('blocked')).toBe('Blocked')
    expect(statusLabel('failed')).toBe('Failed')
  })
})

describe('reqRunStatusLabel', () => {
  it('running 映射为 "Running"', () => {
    expect(reqRunStatusLabel('running')).toBe('Running')
  })

  it('dangling 映射为 "Interrupted"', () => {
    expect(reqRunStatusLabel('dangling')).toBe('Interrupted')
  })

  it('idle 映射为空字符串', () => {
    expect(reqRunStatusLabel('idle')).toBe('')
  })

  it('未知值回退为空字符串', () => {
    expect(reqRunStatusLabel('unknown' as never)).toBe('')
  })
})

describe('showRunStatus', () => {
  it('running 应显示', () => {
    expect(showRunStatus('running')).toBe(true)
  })

  it('dangling 应显示', () => {
    expect(showRunStatus('dangling')).toBe(true)
  })

  it('idle 不应显示', () => {
    expect(showRunStatus('idle')).toBe(false)
  })
})

describe('panelToggleLabel', () => {
  it('展开态下文案提示 "Collapse"', () => {
    const l = panelToggleLabel(false)
    expect(l.text).toBe('Collapse')
    expect(l.icon).toBe('⇤')
    expect(l.title).toContain('Collapse')
  })

  it('收缩态下文案提示 "Expand"', () => {
    const l = panelToggleLabel(true)
    expect(l.text).toBe('Expand')
    expect(l.icon).toBe('⇥')
    expect(l.title).toContain('Expand')
  })
})

describe('rowVisibility', () => {
  it('展开态显示模块名与操作区', () => {
    expect(rowVisibility(false)).toEqual({ showModule: true, showActions: true })
  })

  it('收缩态隐藏模块名与操作区', () => {
    expect(rowVisibility(true)).toEqual({ showModule: false, showActions: false })
  })
})

describe('visibleIntentActions', () => {
  const make = (o: Partial<IntentActionInput>): IntentActionInput => ({
    status: 'todo',
    lastDevSessionId: null,
    prId: null,
    branchName: null,
    ...o,
  })

  it('todo:Refine/Start dev/Mark done/Cancel/automate(无 session/无 PR)', () => {
    expect(visibleIntentActions(make({ status: 'todo' }))).toEqual([
      'refine',
      'startDev',
      'markDone',
      'cancel',
      'automate',
    ])
  })

  it('有 lastDevSessionId 时插入 openSession(顺序在 cancel 之前)', () => {
    expect(visibleIntentActions(make({ status: 'todo', lastDevSessionId: 's-1' }))).toEqual([
      'refine',
      'startDev',
      'openSession',
      'markDone',
      'cancel',
      'automate',
    ])
  })

  it('in_progress:无 Refine/Start dev,有 Mark done/Cancel/automate', () => {
    expect(visibleIntentActions(make({ status: 'in_progress' }))).toEqual([
      'markDone',
      'cancel',
      'automate',
    ])
  })

  it('done 但无 branchName:不显示 Create PR', () => {
    expect(visibleIntentActions(make({ status: 'done' }))).toEqual(['automate'])
  })

  it('有 dev session、无 prId 且 intent 分支不等于 workspace 主分支:显示 Create PR', () => {
    expect(
      visibleIntentActions(
        make({
          status: 'in_progress',
          lastDevSessionId: 'dev-1',
          branchName: 'feature/x',
          workspaceMainBranch: 'main',
        }),
      ),
    ).toEqual(['openSession', 'markDone', 'cancel', 'createPr', 'automate'])
  })

  it('无 dev session 时不显示 Create PR', () => {
    expect(
      visibleIntentActions(
        make({ status: 'in_progress', branchName: 'feature/x', workspaceMainBranch: 'main' }),
      ),
    ).toEqual(['markDone', 'cancel', 'automate'])
  })

  it('done 且 intent 分支等于 workspace 主分支时不显示 Create PR', () => {
    expect(
      visibleIntentActions(
        make({ status: 'done', branchName: 'feature/main', workspaceMainBranch: 'feature/main' }),
      ),
    ).toEqual(['automate'])
  })

  it('比较主分支时归一化 origin/ 与 refs/heads/ 前缀', () => {
    expect(isIntentOnWorkspaceMainBranch('origin/main', 'refs/heads/main')).toBe(true)
    expect(isIntentOnWorkspaceMainBranch('refs/remotes/origin/develop', 'develop')).toBe(true)
    expect(isIntentOnWorkspaceMainBranch('feature/x', 'main')).toBe(false)
    expect(isIntentOnWorkspaceMainBranch(null, 'main')).toBe(false)
  })

  it('done 且有 prId:prLink 而非 Create PR', () => {
    expect(
      visibleIntentActions(make({ status: 'done', branchName: 'feature/x', prId: '42' })),
    ).toEqual(['prLink', 'automate'])
  })

  it('cancelled:仅 automate(终止态无 markDone/cancel/createPr)', () => {
    expect(visibleIntentActions(make({ status: 'cancelled' }))).toEqual(['automate'])
  })

  it('prId 在非 done 态也渲染 prLink', () => {
    expect(visibleIntentActions(make({ status: 'in_progress', prId: '7' }))).toEqual([
      'markDone',
      'cancel',
      'prLink',
      'automate',
    ])
  })

  it('automate 恒为最后一项', () => {
    for (const status of [
      'draft',
      'todo',
      'in_progress',
      'done',
      'cancelled',
      'blocked',
      'failed',
    ] as const) {
      const actions = visibleIntentActions(make({ status }))
      expect(actions[actions.length - 1]).toBe('automate')
    }
  })
})

describe('compareByCompletion', () => {
  const make = (o: Partial<CompletionOrderInput>): CompletionOrderInput => ({
    completedAt: null,
    updatedAt: 0,
    priority: 'P2',
    ...o,
  })
  // locale 透传给 localeCompare;P0..P3 排序与 locale 无关,固定用 'en' 即可。
  const cmp = (a: CompletionOrderInput, b: CompletionOrderInput) => compareByCompletion(a, b, 'en')

  it('不同完成时间按时间倒序(最近完成在前)', () => {
    const older = make({ completedAt: 100 })
    const newer = make({ completedAt: 200 })
    expect(cmp(newer, older)).toBeLessThan(0)
    expect(cmp(older, newer)).toBeGreaterThan(0)
    expect([older, newer].sort(cmp)).toEqual([newer, older])
  })

  it('同完成时间按优先级 P0→P3', () => {
    const p0 = make({ completedAt: 100, priority: 'P0' })
    const p3 = make({ completedAt: 100, priority: 'P3' })
    expect(cmp(p0, p3)).toBeLessThan(0)
    expect([p3, p0].sort(cmp)).toEqual([p0, p3])
  })

  it('缺失 completedAt 时回退到 updatedAt 比较', () => {
    const a = make({ completedAt: null, updatedAt: 300 })
    const b = make({ completedAt: null, updatedAt: 100 })
    expect(cmp(a, b)).toBeLessThan(0)
    expect([b, a].sort(cmp)).toEqual([a, b])
  })

  it('一方有 completedAt、一方回退 updatedAt 时按各自时刻比较', () => {
    const completed = make({ completedAt: 150, updatedAt: 0 })
    const fallback = make({ completedAt: null, updatedAt: 100 })
    // completed 的时刻 150 > fallback 的 100,应排在前
    expect(cmp(completed, fallback)).toBeLessThan(0)
  })

  it('完成时刻与优先级均相同则视为相等(返回 0)', () => {
    const a = make({ completedAt: 100, priority: 'P1' })
    const b = make({ completedAt: 100, priority: 'P1' })
    expect(cmp(a, b)).toBe(0)
  })

  it('cancelled 与 done 混合排序:终止态统一按时刻倒序+优先级', () => {
    const doneLater = make({ completedAt: 300, priority: 'P1' })
    const cancelledMid = make({ completedAt: null, updatedAt: 200, priority: 'P2' })
    const doneEarly = make({ completedAt: 100, priority: 'P0' })
    const sorted = [doneEarly, cancelledMid, doneLater].sort(cmp)
    // 300 > 200 > 100
    expect(sorted).toEqual([doneLater, cancelledMid, doneEarly])
  })

  it('cancelled 项无 completedAt 时回退到 updatedAt', () => {
    const a = make({ completedAt: null, updatedAt: 200, priority: 'P1' })
    const b = make({ completedAt: null, updatedAt: 100, priority: 'P2' })
    // a 的 updatedAt 200 > b 的 100
    expect(cmp(a, b)).toBeLessThan(0)
    expect([b, a].sort(cmp)).toEqual([a, b])
  })
})

describe('sliceTerminated', () => {
  // 用数字数组代表终止态项,只验证切片与 hasMore 逻辑(与元素类型无关)。
  const range = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('每页常量为 10', () => {
    expect(TERMINAL_PAGE_SIZE).toBe(10)
  })

  it('总数不足一页:全显且无更多', () => {
    const { visible, hasMore } = sliceTerminated(range(3), 10)
    expect(visible).toEqual([0, 1, 2])
    expect(hasMore).toBe(false)
  })

  it('总数恰好等于可见数:全显且无更多(边界)', () => {
    const { visible, hasMore } = sliceTerminated(range(10), 10)
    expect(visible).toHaveLength(10)
    expect(hasMore).toBe(false)
  })

  it('总数超过一页:只取前 10 且有更多', () => {
    const { visible, hasMore } = sliceTerminated(range(25), 10)
    expect(visible).toEqual(range(10))
    expect(hasMore).toBe(true)
  })

  it('追加一页后仍有剩余:取前 20 且有更多', () => {
    const { visible, hasMore } = sliceTerminated(range(25), 20)
    expect(visible).toHaveLength(20)
    expect(hasMore).toBe(true)
  })

  it('可见数超过总数:全显且无更多', () => {
    const { visible, hasMore } = sliceTerminated(range(12), 30)
    expect(visible).toHaveLength(12)
    expect(hasMore).toBe(false)
  })

  it('空列表:空片段且无更多', () => {
    const { visible, hasMore } = sliceTerminated([], 10)
    expect(visible).toEqual([])
    expect(hasMore).toBe(false)
  })

  it('可见数为 0 或负:返回空片段,非空源仍标记有更多', () => {
    expect(sliceTerminated(range(5), 0)).toEqual({ visible: [], hasMore: true })
    expect(sliceTerminated(range(5), -3)).toEqual({ visible: [], hasMore: true })
  })

  it('不修改源数组', () => {
    const src = range(15)
    sliceTerminated(src, 10)
    expect(src).toHaveLength(15)
  })
})

describe('formatDate', () => {
  // 2026-05-31 14:30(本地时区);各 locale 经 Intl 本地化排布。
  const ms = new Date(2026, 4, 31, 14, 30).getTime()

  it('short 风格:en 输出月/日两位 MM/DD', () => {
    expect(formatDate(ms, 'en', { style: 'short' })).toBe('05/31')
  })

  it('short 风格:单数字月日补零两位', () => {
    const jan5 = new Date(2026, 0, 5, 8, 3).getTime()
    expect(formatDate(jan5, 'en', { style: 'short' })).toBe('01/05')
  })

  it('full 风格(默认):en 月/日在前,含年与 24h 时分', () => {
    const out = formatDate(ms, 'en')
    // en-US 排布:MM/DD/YYYY, HH:mm —— 不强断标点,校验各部件齐全。
    expect(out).toMatch(/05/)
    expect(out).toMatch(/31/)
    expect(out).toMatch(/2026/)
    expect(out).toMatch(/14:30/)
  })

  it('日期随 locale 本地化:en 与 ja 排布不同,ja 年在前', () => {
    const en = formatDate(ms, 'en')
    const ja = formatDate(ms, 'ja')
    expect(en).not.toBe(ja)
    // 年在前是 ja/zh/ko 的共性;日(31)出现在年(2026)之后。
    expect(ja.indexOf('2026')).toBeLessThan(ja.indexOf('31'))
  })
})

describe('formatDependsOn', () => {
  function makeReq(overrides: Partial<Intent>): Intent {
    return {
      id: 'r-default',
      workspaceId: '/test',
      title: '默认需求',
      shortEnTitle: null,
      content: '',
      priority: 'P2',
      module: '',
      status: 'todo',
      dependsOn: [],
      lastDevSessionId: null,
      automate: false,
      branchName: null,
      latestCommitHash: null,
      prId: null,
      prUrl: null,
      prStatus: null,
      specPath: null,
      specApproved: false,
      specApproveUser: null,
      specSessionId: null,
      intentSessionId: null,
      createdAt: 0,
      updatedAt: 0,
      completedAt: null,
      runStatus: 'idle',
      ...overrides,
    }
  }

  it('无依赖时返回空数组', () => {
    const r = makeReq({ dependsOn: [] })
    expect(formatDependsOn(r, [r])).toEqual([])
  })

  it('含依赖时返回带标题与状态的 DepInfo', () => {
    const depA = makeReq({ id: 'dep-a', title: '需求 A', status: 'done' })
    const depB = makeReq({ id: 'dep-b', title: '需求 B', status: 'todo' })
    const r = makeReq({ id: 'main', dependsOn: ['dep-a', 'dep-b'] })
    const result = formatDependsOn(r, [depA, depB, r])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ id: 'dep-a', title: '需求 A', done: true, depType: 'blocks' })
    expect(result[1]).toEqual({ id: 'dep-b', title: '需求 B', done: false, depType: 'blocks' })
  })

  it('依赖 ID 在列表中不存在时回退用 ID 本身作为标题', () => {
    const r = makeReq({ id: 'main', dependsOn: ['missing-id'] })
    const result = formatDependsOn(r, [r])
    expect(result[0]).toEqual({
      id: 'missing-id',
      title: 'missing-id',
      done: false,
      depType: 'blocks',
    })
  })

  it('包含未完成依赖时 done 字段为 false', () => {
    const dep = makeReq({ id: 'dep', title: '未完成依赖', status: 'in_progress' })
    const r = makeReq({ id: 'main', dependsOn: ['dep'] })
    const result = formatDependsOn(r, [dep, r])
    expect(result[0].done).toBe(false)
  })

  it('已完成依赖的 done 字段为 true', () => {
    const dep = makeReq({ id: 'dep', title: '已完成依赖', status: 'done' })
    const r = makeReq({ id: 'main', dependsOn: ['dep'] })
    const result = formatDependsOn(r, [dep, r])
    expect(result[0].done).toBe(true)
  })

  it('dependsOnTypes 缺失时默认 depType 为 blocks', () => {
    const dep = makeReq({ id: 'dep', title: '依赖项' })
    const r = makeReq({ id: 'main', dependsOn: ['dep'] })
    const result = formatDependsOn(r, [dep, r])
    expect(result[0].depType).toBe('blocks')
  })

  it('dependsOnTypes 为空对象时默认 depType 为 blocks', () => {
    const dep = makeReq({ id: 'dep', title: '依赖项' })
    const r = makeReq({ id: 'main', dependsOn: ['dep'], dependsOnTypes: {} })
    const result = formatDependsOn(r, [dep, r])
    expect(result[0].depType).toBe('blocks')
  })

  it('dependsOnTypes 包含 dep 时使用对应 depType', () => {
    const dep = makeReq({ id: 'dep', title: '依赖项' })
    const dep2 = makeReq({ id: 'dep2', title: '依赖项2' })
    const r = makeReq({
      id: 'main',
      dependsOn: ['dep', 'dep2'],
      dependsOnTypes: { dep: 'informs', dep2: 'soft_after' },
    })
    const result = formatDependsOn(r, [dep, dep2, r])
    expect(result[0].depType).toBe('informs')
    expect(result[1].depType).toBe('soft_after')
  })
})
