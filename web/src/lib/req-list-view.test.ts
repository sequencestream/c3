import { describe, it, expect } from 'vitest'
import type { CompletionOrderInput } from './req-list-view'
import { compareByCompletion, panelToggleLabel, rowVisibility, statusLabel } from './req-list-view'

describe('statusLabel', () => {
  it('五种状态各映射到对应中文标签', () => {
    expect(statusLabel('draft')).toBe('草稿')
    expect(statusLabel('todo')).toBe('未开始')
    expect(statusLabel('in_progress')).toBe('开发中')
    expect(statusLabel('done')).toBe('已完成')
    expect(statusLabel('cancelled')).toBe('已取消')
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
    createdAt: 0,
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

  it('缺失 completedAt 时回退到 createdAt 比较', () => {
    const a = make({ completedAt: null, createdAt: 300 })
    const b = make({ completedAt: null, createdAt: 100 })
    expect(compareByCompletion(a, b)).toBeLessThan(0)
    expect([b, a].sort(compareByCompletion)).toEqual([a, b])
  })

  it('一方有 completedAt、一方回退 createdAt 时按各自时刻比较', () => {
    const completed = make({ completedAt: 150, createdAt: 0 })
    const fallback = make({ completedAt: null, createdAt: 100 })
    // completed 的时刻 150 > fallback 的 100,应排在前
    expect(compareByCompletion(completed, fallback)).toBeLessThan(0)
  })

  it('完成时刻与优先级均相同则视为相等(返回 0)', () => {
    const a = make({ completedAt: 100, priority: 'P1' })
    const b = make({ completedAt: 100, priority: 'P1' })
    expect(compareByCompletion(a, b)).toBe(0)
  })
})
