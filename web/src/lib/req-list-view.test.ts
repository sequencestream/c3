import { describe, it, expect } from 'vitest'
import { panelToggleLabel, rowVisibility, statusLabel } from './req-list-view'

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
