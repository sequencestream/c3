import { describe, it, expect } from 'vitest'
import { autoGrowHeight } from './textarea'

describe('textarea — autoGrowHeight(textarea 自动拉伸)', () => {
  it('内容低于上限:高度跟随内容,内部不滚动', () => {
    expect(autoGrowHeight(80, 200)).toEqual({ height: 80, overflowY: 'hidden' })
  })

  it('内容恰好等于上限:不视为溢出,仍不滚动', () => {
    expect(autoGrowHeight(200, 200)).toEqual({ height: 200, overflowY: 'hidden' })
  })

  it('内容超过上限:高度封顶到上限并出现内部滚动条', () => {
    expect(autoGrowHeight(360, 200)).toEqual({ height: 200, overflowY: 'auto' })
  })

  it('空内容:高度收缩到 scrollHeight(复位场景)', () => {
    expect(autoGrowHeight(0, 200)).toEqual({ height: 0, overflowY: 'hidden' })
  })
})
