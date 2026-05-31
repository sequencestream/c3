import { describe, it, expect } from 'vitest'
import type { PendingItem } from './pending-queue'
import {
  appendItem,
  composerAction,
  mergeIntoDraft,
  mergeQueue,
  removeItem,
  shouldFlush,
} from './pending-queue'

const items = (...texts: string[]): PendingItem[] => texts.map((text, id) => ({ id, text }))

describe('mergeQueue', () => {
  it('按顺序、用空行连接合并', () => {
    expect(mergeQueue(items('a', 'b', 'c'))).toBe('a\n\nb\n\nc')
  })

  it('单条不加分隔符', () => {
    expect(mergeQueue(items('solo'))).toBe('solo')
  })

  it('空队列合并为空串', () => {
    expect(mergeQueue([])).toBe('')
  })
})

describe('shouldFlush', () => {
  it('就绪(非 running)且队列非空 → 触发', () => {
    expect(shouldFlush(false, false, 1)).toBe(true)
  })

  it('running 时不触发', () => {
    expect(shouldFlush(true, false, 3)).toBe(false)
  })

  it('空队列不触发', () => {
    expect(shouldFlush(false, false, 0)).toBe(false)
  })

  it('团队会话不触发(实时 pushInput,不入队)', () => {
    expect(shouldFlush(false, true, 2)).toBe(false)
  })
})

describe('composerAction', () => {
  it('普通会话运行中 = 入队', () => {
    expect(composerAction(true, false)).toBe('enqueue')
  })

  it('就绪 = 立即发送', () => {
    expect(composerAction(false, false)).toBe('send')
  })

  it('团队会话运行中 = 立即发送(投喂 lead)', () => {
    expect(composerAction(true, true)).toBe('send')
  })
})

describe('appendItem / removeItem', () => {
  it('追加返回新数组、保留顺序', () => {
    const before = items('a')
    const after = appendItem(before, 'b', 1)
    expect(after).toEqual([
      { id: 0, text: 'a' },
      { id: 1, text: 'b' },
    ])
    expect(before).toHaveLength(1) // 不可变
  })

  it('按 id 移除指定条目', () => {
    const after = removeItem(items('a', 'b', 'c'), 1)
    expect(after).toEqual([
      { id: 0, text: 'a' },
      { id: 2, text: 'c' },
    ])
  })

  it('移除不存在的 id 原样返回内容', () => {
    expect(removeItem(items('a'), 99)).toEqual([{ id: 0, text: 'a' }])
  })
})

describe('mergeIntoDraft', () => {
  it('草稿为空时取条目文本', () => {
    expect(mergeIntoDraft('', 'hello')).toBe('hello')
    expect(mergeIntoDraft('   ', 'hello')).toBe('hello')
  })

  it('草稿非空时以单换行追加', () => {
    expect(mergeIntoDraft('draft', 'hello')).toBe('draft\nhello')
  })

  it('追加前去掉草稿尾部空白,只保留单换行', () => {
    expect(mergeIntoDraft('draft  \n', 'hello')).toBe('draft\nhello')
  })
})
