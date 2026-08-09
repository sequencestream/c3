import { describe, expect, it } from 'vitest'
import { gateEscapeFor } from './gate-escape'

describe('gateEscapeFor', () => {
  it('依赖闸门三态都给出「强制放行」出口', () => {
    for (const code of [
      'intent.dependencyNotMerged',
      'intent.dependencyPrUnmergedInDelivery',
      'intent.dependencyDeliveryNotDelivered',
    ]) {
      expect(gateEscapeFor(code, 'i1')).toEqual({ kind: 'dependency', intentId: 'i1' })
    }
  })

  // 基线不符已不拦启动,因此这里没有它的出口:提示与两个修复动作都在意图详情的
  // WorktreeBaselineBanner 上,不再经这条「被拒之后给出口」的路径。
  it('基线不符不在此列 —— 它根本不产生拒绝', () => {
    expect(gateEscapeFor('intent.worktreeBaseMismatch', 'i1')).toBeNull()
    expect(gateEscapeFor('intent.worktreeBaseMismatchDirty', 'i1')).toBeNull()
  })

  it('多交付关联给出「选定交付」出口', () => {
    expect(gateEscapeFor('intent.deliveryContextRequired', 'i1')).toEqual({
      kind: 'delivery-context',
      intentId: 'i1',
    })
  })

  it('其它错误没有出口', () => {
    expect(gateEscapeFor('intent.specNotApproved', 'i1')).toBeNull()
    expect(gateEscapeFor('intent.deliveryNotWritable', 'i1')).toBeNull()
    expect(gateEscapeFor('intent.concurrencyGate', 'i1')).toBeNull()
  })

  it('没有可归属的意图时不给出口:点了也无处可去', () => {
    expect(gateEscapeFor('intent.dependencyNotMerged', null)).toBeNull()
    expect(gateEscapeFor('intent.deliveryContextRequired', null)).toBeNull()
  })
})
