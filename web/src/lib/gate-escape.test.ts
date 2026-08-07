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

  it('基线不符按 worktree 是否干净分成两个出口集合', () => {
    expect(gateEscapeFor('intent.worktreeBaseMismatch', 'i1')).toEqual({
      kind: 'worktree-clean',
      intentId: 'i1',
    })
    expect(gateEscapeFor('intent.worktreeBaseMismatchDirty', 'i1')).toEqual({
      kind: 'worktree-dirty',
      intentId: 'i1',
    })
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
    expect(gateEscapeFor('intent.worktreeBaseMismatch', null)).toBeNull()
  })
})
