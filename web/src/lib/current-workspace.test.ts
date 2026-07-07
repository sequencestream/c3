import { describe, it, expect } from 'vitest'
import { resolveCurrentWorkspace } from './current-workspace'
import type { WorkspaceInfo } from '@ccc/shared/protocol'

const ws = (id: string): WorkspaceInfo => ({
  id,
  name: id.split('/').pop() ?? id,
  path: id,
  lastAccessed: 0,
})

describe('resolveCurrentWorkspace', () => {
  const list = [ws('/a'), ws('/b'), ws('/c')]

  it('保留仍在列表中的持久化选择', () => {
    expect(resolveCurrentWorkspace('/b', list)).toBe('/b')
  })

  it('持久值已不在列表 → 回落到最近访问(首项)', () => {
    expect(resolveCurrentWorkspace('/gone', list)).toBe('/a')
  })

  it('无持久值 → 回落到首项', () => {
    expect(resolveCurrentWorkspace(null, list)).toBe('/a')
  })

  it('空工作区列表 → null', () => {
    expect(resolveCurrentWorkspace('/a', [])).toBe(null)
    expect(resolveCurrentWorkspace(null, [])).toBe(null)
  })
})
