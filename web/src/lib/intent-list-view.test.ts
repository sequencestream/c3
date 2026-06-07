import { describe, it, expect } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import type { CompletionOrderInput } from './intent-list-view'
import {
  compareByCompletion,
  formatDate,
  formatDependsOn,
  panelToggleLabel,
  reqRunStatusLabel,
  rowVisibility,
  showRunStatus,
  statusLabel,
} from './intent-list-view'

describe('statusLabel', () => {
  it('五种状态各映射到对应英文标签', () => {
    expect(statusLabel('draft')).toBe('Draft')
    expect(statusLabel('todo')).toBe('To do')
    expect(statusLabel('in_progress')).toBe('In progress')
    expect(statusLabel('done')).toBe('Done')
    expect(statusLabel('cancelled')).toBe('Cancelled')
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
      projectPath: '/test',
      title: '默认需求',
      content: '',
      priority: 'P2',
      module: '',
      status: 'todo',
      dependsOn: [],
      lastDevSessionId: null,
      automate: false,
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
    expect(result[0]).toEqual({ id: 'dep-a', title: '需求 A', done: true })
    expect(result[1]).toEqual({ id: 'dep-b', title: '需求 B', done: false })
  })

  it('依赖 ID 在列表中不存在时回退用 ID 本身作为标题', () => {
    const r = makeReq({ id: 'main', dependsOn: ['missing-id'] })
    const result = formatDependsOn(r, [r])
    expect(result[0]).toEqual({ id: 'missing-id', title: 'missing-id', done: false })
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
})
