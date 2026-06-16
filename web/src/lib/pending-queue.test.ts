import { describe, it, expect } from 'vitest'
import type { PendingItem } from './pending-queue'
import type { PromptImage } from '@ccc/shared/protocol'
import {
  appendItem,
  composerAction,
  mergeImages,
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

  // 电平触发(level),非边沿:flush 兜底改为每次状态对账后调用,所以 shouldFlush
  // 只看「当前是否就绪且队列非空」,与上一次状态无关——重复观察 idle 必须都返回 true,
  // 否则错过一次 running→idle 跳变后队列将永久滞留。
  it('对同一就绪态重复求值都返回 true(level,不依赖跳变)', () => {
    expect(shouldFlush(false, false, 2)).toBe(true)
    expect(shouldFlush(false, false, 2)).toBe(true) // 再次对账仍应触发
  })
})

// 运行中入队多条,回合结束后合并为一条 prompt 自动发出:flush 路径取 mergeQueue
// 的结果作为单条 prompt,故多条按序以空行合并为一。
describe('flush 合并(运行中入队多条 → 回合结束合并为一条)', () => {
  it('多条入队按序合并为一条 prompt', () => {
    const q = items('第一条', '第二条', '第三条')
    expect(shouldFlush(false, false, q.length)).toBe(true)
    expect(mergeQueue(q)).toBe('第一条\n\n第二条\n\n第三条')
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

describe('appendItem / mergeImages — 附图', () => {
  const img = (data: string): PromptImage => ({ mediaType: 'image/png', data })

  it('appendItem 带图时写入 images,空图省略字段', () => {
    expect(appendItem([], 'a', 0, [img('AAAA')])).toEqual([
      { id: 0, text: 'a', images: [{ mediaType: 'image/png', data: 'AAAA' }] },
    ])
    expect(appendItem([], 'b', 1, [])).toEqual([{ id: 1, text: 'b' }])
    expect(appendItem([], 'c', 2)).toEqual([{ id: 2, text: 'c' }])
  })

  it('mergeImages 按序拼平各条目附图(无图条目跳过)', () => {
    const q: PendingItem[] = [
      { id: 0, text: 'a', images: [img('AAAA')] },
      { id: 1, text: 'b' },
      { id: 2, text: 'c', images: [img('BBBB'), img('CCCC')] },
    ]
    expect(mergeImages(q)).toEqual([img('AAAA'), img('BBBB'), img('CCCC')])
  })

  it('全无图 → 空数组', () => {
    expect(mergeImages(items('a', 'b'))).toEqual([])
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
