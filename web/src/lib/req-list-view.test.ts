import { describe, it, expect } from 'vitest'
import type { Requirement } from '@ccc/shared/protocol'
import type { CompletionOrderInput } from './req-list-view'
import {
  compareByCompletion,
  formatDate,
  formatDependsOn,
  panelToggleLabel,
  reqRunStatusLabel,
  rowVisibility,
  showRunStatus,
  statusLabel,
} from './req-list-view'

describe('statusLabel', () => {
  it('五种状态各映射到对应中文标签', () => {
    expect(statusLabel('draft')).toBe('草稿')
    expect(statusLabel('todo')).toBe('未开始')
    expect(statusLabel('in_progress')).toBe('开发中')
    expect(statusLabel('done')).toBe('已完成')
    expect(statusLabel('cancelled')).toBe('已取消')
  })
})

describe('reqRunStatusLabel', () => {
  it('running 映射为"运行中"', () => {
    expect(reqRunStatusLabel('running')).toBe('运行中')
  })

  it('dangling 映射为"已中断"', () => {
    expect(reqRunStatusLabel('dangling')).toBe('已中断')
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
  it('展开态下文案提示「收起」', () => {
    const l = panelToggleLabel(false)
    expect(l.text).toBe('收起')
    expect(l.icon).toBe('⇤')
    expect(l.title).toContain('收起')
  })

  it('收缩态下文案提示「展开」', () => {
    const l = panelToggleLabel(true)
    expect(l.text).toBe('展开')
    expect(l.icon).toBe('⇥')
    expect(l.title).toContain('展开')
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

  it('不同完成时间按时间倒序(最近完成在前)', () => {
    const older = make({ completedAt: 100 })
    const newer = make({ completedAt: 200 })
    expect(compareByCompletion(newer, older)).toBeLessThan(0)
    expect(compareByCompletion(older, newer)).toBeGreaterThan(0)
    expect([older, newer].sort(compareByCompletion)).toEqual([newer, older])
  })

  it('同完成时间按优先级 P0→P3', () => {
    const p0 = make({ completedAt: 100, priority: 'P0' })
    const p3 = make({ completedAt: 100, priority: 'P3' })
    expect(compareByCompletion(p0, p3)).toBeLessThan(0)
    expect([p3, p0].sort(compareByCompletion)).toEqual([p0, p3])
  })

  it('缺失 completedAt 时回退到 updatedAt 比较', () => {
    const a = make({ completedAt: null, updatedAt: 300 })
    const b = make({ completedAt: null, updatedAt: 100 })
    expect(compareByCompletion(a, b)).toBeLessThan(0)
    expect([b, a].sort(compareByCompletion)).toEqual([a, b])
  })

  it('一方有 completedAt、一方回退 updatedAt 时按各自时刻比较', () => {
    const completed = make({ completedAt: 150, updatedAt: 0 })
    const fallback = make({ completedAt: null, updatedAt: 100 })
    // completed 的时刻 150 > fallback 的 100,应排在前
    expect(compareByCompletion(completed, fallback)).toBeLessThan(0)
  })

  it('完成时刻与优先级均相同则视为相等(返回 0)', () => {
    const a = make({ completedAt: 100, priority: 'P1' })
    const b = make({ completedAt: 100, priority: 'P1' })
    expect(compareByCompletion(a, b)).toBe(0)
  })

  it('cancelled 与 done 混合排序:终止态统一按时刻倒序+优先级', () => {
    const doneLater = make({ completedAt: 300, priority: 'P1' })
    const cancelledMid = make({ completedAt: null, updatedAt: 200, priority: 'P2' })
    const doneEarly = make({ completedAt: 100, priority: 'P0' })
    const sorted = [doneEarly, cancelledMid, doneLater].sort(compareByCompletion)
    // 300 > 200 > 100
    expect(sorted).toEqual([doneLater, cancelledMid, doneEarly])
  })

  it('cancelled 项无 completedAt 时回退到 updatedAt', () => {
    const a = make({ completedAt: null, updatedAt: 200, priority: 'P1' })
    const b = make({ completedAt: null, updatedAt: 100, priority: 'P2' })
    // a 的 updatedAt 200 > b 的 100
    expect(compareByCompletion(a, b)).toBeLessThan(0)
    expect([b, a].sort(compareByCompletion)).toEqual([a, b])
  })
})

describe('formatDate', () => {
  it('short 风格输出 MM/DD', () => {
    const d = new Date(2026, 4, 31, 14, 30)
    expect(formatDate(d.getTime(), { style: 'short' })).toBe('05/31')
  })

  it('月份日期的单数字自动补零', () => {
    const d = new Date(2026, 0, 5, 8, 3)
    expect(formatDate(d.getTime(), { style: 'short' })).toBe('01/05')
  })

  it('full 风格(默认)输出 YYYY-MM-DD HH:mm', () => {
    const d = new Date(2026, 4, 31, 14, 30)
    expect(formatDate(d.getTime())).toBe('2026-05-31 14:30')
  })

  it('full 风格不传入 opts 时默认使用完整格式', () => {
    const d = new Date(2026, 0, 1, 9, 5)
    expect(formatDate(d.getTime())).toBe('2026-01-01 09:05')
  })
})

describe('formatDependsOn', () => {
  function makeReq(overrides: Partial<Requirement>): Requirement {
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
