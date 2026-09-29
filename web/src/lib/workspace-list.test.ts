import { describe, it, expect } from 'vitest'
import { sortWorkspacesByRecency, touchWorkspaceAccess } from './workspace-list'
import type { WorkspaceInfo } from '@ccc/shared/protocol'

const ws = (name: string, lastAccessed: number, path = `/home/alice/${name}`): WorkspaceInfo => ({
  name,
  path,
  lastAccessed,
})

describe('sortWorkspacesByRecency', () => {
  it('按最近访问时间倒序:刚碰过的排最上', () => {
    const sorted = sortWorkspacesByRecency([ws('old', 100), ws('newest', 300), ws('mid', 200)])
    expect(sorted.map((w) => w.name)).toEqual(['newest', 'mid', 'old'])
  })

  it('输入乱序时同样给出正确顺序 —— 服务端已排序只是默认,不是前提', () => {
    const sorted = sortWorkspacesByRecency([ws('b', 1), ws('c', 3), ws('a', 2)])
    expect(sorted.map((w) => w.name)).toEqual(['c', 'a', 'b'])
  })

  it('时间相同则按名称升序,顺序不随引擎的稳定性实现而跳动', () => {
    const sorted = sortWorkspacesByRecency([ws('proj-c', 5), ws('proj-a', 5), ws('proj-b', 5)])
    expect(sorted.map((w) => w.name)).toEqual(['proj-a', 'proj-b', 'proj-c'])
  })

  it('不改传入的数组本身(纯函数,调用方自行替换 ref)', () => {
    const input = [ws('a', 1), ws('b', 2)]
    const copy = [...input]
    sortWorkspacesByRecency(input)
    expect(input).toEqual(copy)
  })

  it('空列表 → 空列表', () => {
    expect(sortWorkspacesByRecency([])).toEqual([])
  })
})

describe('touchWorkspaceAccess', () => {
  it('刚访问过的工作区重排到顶部,其余项相对顺序不变', () => {
    const sorted = touchWorkspaceAccess([ws('a', 300), ws('b', 200), ws('c', 100)], 'c', 999)
    expect(sorted.map((w) => w.name)).toEqual(['c', 'a', 'b'])
    expect(sorted[0]!.lastAccessed).toBe(999)
  })

  it('既接受工作区名,也接受绝对路径 —— 与切换动作可能传入的两种形式一致', () => {
    const byName = touchWorkspaceAccess([ws('a', 300), ws('b', 200)], 'b', 999)
    expect(byName.map((w) => w.name)).toEqual(['b', 'a'])
    const byPath = touchWorkspaceAccess([ws('a', 300), ws('b', 200, '/srv/b')], '/srv/b', 999)
    expect(byPath.map((w) => w.name)).toEqual(['b', 'a'])
  })

  it('命中的是副本:原数组与其中的对象都不被就地改写', () => {
    const input = [ws('a', 300), ws('b', 200)]
    const sorted = touchWorkspaceAccess(input, 'b', 999)
    expect(input[1]!.lastAccessed).toBe(200)
    expect(sorted[0]).not.toBe(input[1])
  })

  it('目标不在列表里(工作区已被移除)→ 只排序,不凭空造一项', () => {
    const sorted = touchWorkspaceAccess([ws('a', 100), ws('b', 300)], 'gone', 999)
    expect(sorted.map((w) => w.name)).toEqual(['b', 'a'])
  })
})
