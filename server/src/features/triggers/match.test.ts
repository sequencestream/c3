/**
 * `evaluateAutomationTriggerMatch` 的纯匹配语义 —— 重点覆盖「一次性内部 run 必须被
 * 显式点名才参与触发」这条规则:advisor / 标题生成这类 run 也发 run 生命周期事件
 * (为了日志与审计可见),但它们频次高、几乎不是用户想触发自动化的那种 run,所以
 * 空的 sessionKind 过滤器对它们不再意味着「全都要」。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
// 匹配是纯函数,不需要真的调度器/数据库。
vi.mock('../automations/engine.js', () => ({
  dispatchAndTrack: vi.fn(),
  getStore: () => null,
  inFlight: new Map(),
}))

import type { Automation, SessionKind } from '@ccc/shared/protocol'
import { evaluateAutomationTriggerMatch, type TriggerEventView } from './index.js'

const WS = '/abs/ws'

function automation(sessionKinds?: SessionKind[]): Automation {
  return {
    workspaceId: WS,
    eventFilters: [{ type: 'run:settled' }],
    ...(sessionKinds ? { eventSessionKindFilter: sessionKinds } : {}),
  } as unknown as Automation
}

function settledView(sessionKind: SessionKind): TriggerEventView {
  return {
    workspacePath: WS,
    sessionKind,
    event: { type: 'run:settled', status: 'complete', metadata: { sessionKind } },
  }
}

describe('run 生命周期事件的 sessionKind 维度', () => {
  it('空过滤器仍然匹配普通用户 run', () => {
    expect(evaluateAutomationTriggerMatch(automation(), settledView('work')).matched).toBe(true)
  })

  it('空过滤器不再匹配一次性内部 run', () => {
    const result = evaluateAutomationTriggerMatch(automation(), settledView('tool'))
    expect(result.matched).toBe(false)
    expect(result.breakdown).toContainEqual({ name: 'sessionKind', passed: false })
  })

  it('显式点名后一次性内部 run 才参与匹配', () => {
    expect(evaluateAutomationTriggerMatch(automation(['tool']), settledView('tool')).matched).toBe(
      true,
    )
  })

  it('非空白名单仍是精确白名单,未列入的场景不匹配', () => {
    expect(
      evaluateAutomationTriggerMatch(automation(['work']), settledView('intent')).matched,
    ).toBe(false)
  })

  it('非 run 类事件不受这条规则影响', () => {
    const view: TriggerEventView = {
      workspacePath: WS,
      event: { type: 'pr:create', status: 'success' },
    }
    const pr = {
      workspaceId: WS,
      eventFilters: [{ type: 'pr:create' }],
    } as unknown as Automation
    expect(evaluateAutomationTriggerMatch(pr, view).matched).toBe(true)
  })
})
