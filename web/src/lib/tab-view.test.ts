import { describe, it, expect } from 'vitest'
import {
  consoleEntryTarget,
  consoleTabEntryEffects,
  workspaceSwitchEffects,
  type SessionRef,
} from './tab-view'
import type { SessionInfo } from '@ccc/shared/protocol'

const sess = (sessionId: string): SessionInfo => ({
  sessionId,
  title: sessionId,
  lastModified: 0,
  mode: 'default',
  isToolSession: false,
  vendor: 'claude',
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

describe('workspaceSwitchEffects', () => {
  it('目标 = 当前工作区 → noop,不刷新不切 tab', () => {
    expect(workspaceSwitchEffects('/ws', '/ws')).toEqual({
      noop: true,
      refreshSessions: false,
      enterConsole: false,
    })
  })

  it('切到不同工作区 → 强制刷新 + 落 console tab', () => {
    expect(workspaceSwitchEffects('/ws-b', '/ws-a')).toEqual({
      noop: false,
      refreshSessions: true,
      enterConsole: true,
    })
  })

  it('从无当前工作区切入 → 强制刷新 + 落 console tab', () => {
    expect(workspaceSwitchEffects('/ws', null)).toEqual({
      noop: false,
      refreshSessions: true,
      enterConsole: true,
    })
  })
})

describe('consoleTabEntryEffects', () => {
  it('从其他 tab 进入(wasOther=true) → 重绑 + 强制刷新当前工作区', () => {
    expect(consoleTabEntryEffects(true)).toEqual({ rebind: true, refreshSessions: true })
  })

  it('已在 console tab 再点(wasOther=false) → 不重绑不刷新', () => {
    expect(consoleTabEntryEffects(false)).toEqual({ rebind: false, refreshSessions: false })
  })
})
