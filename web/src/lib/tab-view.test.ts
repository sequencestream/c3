import { describe, it, expect } from 'vitest'
import { consoleEntryTarget, type SessionRef } from './tab-view'
import type { SessionInfo } from '@ccc/shared/protocol'

const sess = (sessionId: string): SessionInfo => ({
  sessionId,
  title: sessionId,
  lastModified: 0,
  mode: 'default',
  isToolSession: false,
})

describe('consoleEntryTarget', () => {
  const list = [sess('a'), sess('b'), sess('c')]

  it('记住过会话 → 原样重选(独立于侧栏 currentWorkspace)', () => {
    const remembered: SessionRef = { workspacePath: '/ws-x', sessionId: 'a' }
    // currentWorkspace 与 remembered.workspacePath 不同也按 remembered 走
    expect(consoleEntryTarget(remembered, '/ws-y', list)).toEqual({
      kind: 'select',
      ref: remembered,
    })
  })

  it('从未选过 → 回退当前工作区列表首个', () => {
    expect(consoleEntryTarget(null, '/ws', list)).toEqual({
      kind: 'select',
      ref: { workspacePath: '/ws', sessionId: 'a' },
    })
  })

  it('从未选过且列表为空 → 空态', () => {
    expect(consoleEntryTarget(null, '/ws', [])).toEqual({ kind: 'empty' })
  })

  it('从未选过且无当前工作区 → 空态', () => {
    expect(consoleEntryTarget(null, null, list)).toEqual({ kind: 'empty' })
  })

  it('记住的会话即使列表里已不存在,也仍按 remembered 走(删除由调用方清指针)', () => {
    const remembered: SessionRef = { workspacePath: '/ws', sessionId: 'gone' }
    expect(consoleEntryTarget(remembered, '/ws', list)).toEqual({
      kind: 'select',
      ref: remembered,
    })
  })
})
