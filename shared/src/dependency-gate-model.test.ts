/**
 * The dependency gate's three states, pinned on the ONE criterion both readers
 * share. Everything here is pure data — if a case needs a store or a git call to
 * express, it belongs to a reader's adapter, not to this function.
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateDependencyGate,
  gateWantsPrStatusSync,
  type DependencyGateFact,
  type DependencyGateInput,
} from './dependency-gate-model.js'
import type { DeliveryGateFact } from './delivery-gate-model.js'

function dep(over: Partial<DependencyGateFact> = {}): DependencyGateFact {
  return {
    id: 'dep-1',
    title: '依赖 A',
    status: 'done',
    branchName: 'intent/abc-dep',
    deliveryIds: [],
    prStatusByDelivery: {},
    prAggregate: null,
    ...over,
  }
}

function delivery(over: Partial<DeliveryGateFact> = {}): DeliveryGateFact {
  return { id: 'del-1', title: '交付 X', status: 'integrating', ...over }
}

function input(over: Partial<DependencyGateInput> = {}): DependencyGateInput {
  return {
    dependsOn: ['dep-1'],
    dependencies: [dep()],
    sessionDeliveryId: null,
    deliveries: [],
    gitBranchMode: 'worktree',
    defaultMainBranch: 'main',
    ...over,
  }
}

describe('evaluateDependencyGate — 通用前置', () => {
  it('无依赖时放行', () => {
    expect(evaluateDependencyGate(input({ dependsOn: [], dependencies: [] }))).toEqual({
      blocked: false,
    })
  })

  it('未知依赖 id(跨工作区/已删除)不阻塞', () => {
    expect(evaluateDependencyGate(input({ dependsOn: ['ghost'], dependencies: [] }))).toEqual({
      blocked: false,
    })
  })

  it('依赖未 done 时以 not_done 阻塞,与交付无关', () => {
    const v = evaluateDependencyGate(
      input({
        dependencies: [dep({ status: 'in_progress', deliveryIds: ['del-1'] })],
        sessionDeliveryId: 'del-1',
        deliveries: [delivery()],
      }),
    )
    expect(v).toEqual({
      blocked: true,
      reason: 'not_done',
      dependency: { id: 'dep-1', title: '依赖 A' },
      delivery: null,
    })
  })

  it('current-branch 模式下只要求 done,交付维度一律不参与', () => {
    const v = evaluateDependencyGate(
      input({
        gitBranchMode: 'current-branch',
        dependencies: [dep({ deliveryIds: ['del-2'], prStatusByDelivery: {} })],
        sessionDeliveryId: 'del-1',
        deliveries: [delivery({ id: 'del-2', status: 'planned' })],
      }),
    )
    expect(v).toEqual({ blocked: false })
  })

  it('按 dependsOn 声明顺序报告第一个阻塞者', () => {
    const v = evaluateDependencyGate(
      input({
        dependsOn: ['dep-1', 'dep-2'],
        dependencies: [
          dep({ id: 'dep-1', title: 'A', status: 'done', prAggregate: 'merged' }),
          dep({ id: 'dep-2', title: 'B', status: 'todo' }),
        ],
      }),
    )
    expect(v).toMatchObject({ blocked: true, dependency: { id: 'dep-2' } })
  })
})

describe('三态 ①:同交付', () => {
  const same = (prStatus: 'merged' | 'reviewing' | null): DependencyGateInput =>
    input({
      sessionDeliveryId: 'del-1',
      dependencies: [dep({ deliveryIds: ['del-1'], prStatusByDelivery: { 'del-1': prStatus } })],
      deliveries: [delivery()],
    })

  it('依赖对该交付的 PR 已合入 → 放行', () => {
    expect(evaluateDependencyGate(same('merged'))).toEqual({ blocked: false })
  })

  it('依赖对该交付的 PR 未合入 → pr_unmerged,并指向我的交付', () => {
    expect(evaluateDependencyGate(same('reviewing'))).toEqual({
      blocked: true,
      reason: 'pr_unmerged',
      dependency: { id: 'dep-1', title: '依赖 A' },
      delivery: { id: 'del-1', title: '交付 X' },
    })
  })

  it('依赖对该交付根本没有 PR 行 → 同样 pr_unmerged', () => {
    expect(evaluateDependencyGate(same(null))).toMatchObject({ reason: 'pr_unmerged' })
  })

  it('对其他交付的 PR 已合入不影响本判定(按交付看,不看聚合)', () => {
    const v = evaluateDependencyGate(
      input({
        sessionDeliveryId: 'del-1',
        dependencies: [
          dep({
            deliveryIds: ['del-1', 'del-2'],
            prStatusByDelivery: { 'del-1': 'reviewing', 'del-2': 'merged' },
            prAggregate: 'merged',
          }),
        ],
        deliveries: [delivery(), delivery({ id: 'del-2', title: '交付 Y' })],
      }),
    )
    expect(v).toMatchObject({ reason: 'pr_unmerged', delivery: { id: 'del-1' } })
  })
})

describe('三态 ②:跨交付', () => {
  it('依赖所属交付未 delivered → delivery_not_delivered,指向依赖那边的交付', () => {
    const v = evaluateDependencyGate(
      input({
        sessionDeliveryId: 'del-1',
        dependencies: [dep({ deliveryIds: ['del-2'], prStatusByDelivery: { 'del-2': 'merged' } })],
        deliveries: [delivery(), delivery({ id: 'del-2', title: '交付 Y', status: 'verifying' })],
      }),
    )
    expect(v).toEqual({
      blocked: true,
      reason: 'delivery_not_delivered',
      dependency: { id: 'dep-1', title: '依赖 A' },
      delivery: { id: 'del-2', title: '交付 Y' },
    })
  })

  it('依赖所属交付已 delivered → 放行', () => {
    const v = evaluateDependencyGate(
      input({
        sessionDeliveryId: 'del-1',
        dependencies: [dep({ deliveryIds: ['del-2'] })],
        deliveries: [delivery(), delivery({ id: 'del-2', title: '交付 Y', status: 'delivered' })],
      }),
    )
    expect(v).toEqual({ blocked: false })
  })

  it('多关联保守收口:只要有一个非当前交付未 delivered 就阻塞', () => {
    const v = evaluateDependencyGate(
      input({
        sessionDeliveryId: 'del-1',
        dependencies: [dep({ deliveryIds: ['del-2', 'del-3'] })],
        deliveries: [
          delivery(),
          delivery({ id: 'del-2', title: '交付 Y', status: 'delivered' }),
          delivery({ id: 'del-3', title: '交付 Z', status: 'planned' }),
        ],
      }),
    )
    expect(v).toMatchObject({ reason: 'delivery_not_delivered', delivery: { id: 'del-3' } })
  })

  it('交付快照缺失(未知 id)按未 delivered 处理,标题回退为 id', () => {
    const v = evaluateDependencyGate(
      input({
        sessionDeliveryId: 'del-1',
        dependencies: [dep({ deliveryIds: ['del-gone'] })],
        deliveries: [delivery()],
      }),
    )
    expect(v).toMatchObject({
      reason: 'delivery_not_delivered',
      delivery: { id: 'del-gone', title: 'del-gone' },
    })
  })
})

describe('三态 ③:无交付 —— 旧判据行为不变', () => {
  it('聚合 PR merged → 放行', () => {
    const v = evaluateDependencyGate(input({ dependencies: [dep({ prAggregate: 'merged' })] }))
    expect(v).toEqual({ blocked: false })
  })

  it('依赖分支即主线 → 放行', () => {
    const v = evaluateDependencyGate(
      input({ dependencies: [dep({ branchName: 'main', prAggregate: 'reviewing' })] }),
    )
    expect(v).toEqual({ blocked: false })
  })

  it('依赖没有分支 → 放行(历史行为)', () => {
    const v = evaluateDependencyGate(input({ dependencies: [dep({ branchName: null })] }))
    expect(v).toEqual({ blocked: false })
  })

  it('远端/refs 前缀在比较前归一化', () => {
    const v = evaluateDependencyGate(
      input({ dependencies: [dep({ branchName: 'refs/remotes/origin/main' })] }),
    )
    expect(v).toEqual({ blocked: false })
  })

  it('分支非主线且 PR 未合入 → not_on_mainline', () => {
    const v = evaluateDependencyGate(input({ dependencies: [dep({ prAggregate: 'reviewing' })] }))
    expect(v).toEqual({
      blocked: true,
      reason: 'not_on_mainline',
      dependency: { id: 'dep-1', title: '依赖 A' },
      delivery: null,
    })
  })

  it('工作区未配置主线分支 → 仍按 not_on_mainline 阻塞', () => {
    const v = evaluateDependencyGate(
      input({ defaultMainBranch: null, dependencies: [dep({ branchName: 'main' })] }),
    )
    expect(v).toMatchObject({ reason: 'not_on_mainline' })
  })

  it('会话无交付上下文时,依赖即使关联了交付也走旧判据', () => {
    const v = evaluateDependencyGate(
      input({
        sessionDeliveryId: null,
        dependencies: [
          dep({
            deliveryIds: ['del-2'],
            prStatusByDelivery: { 'del-2': 'merged' },
            prAggregate: 'merged',
          }),
        ],
        deliveries: [delivery({ id: 'del-2', status: 'planned' })],
      }),
    )
    expect(v).toEqual({ blocked: false })
  })

  it('会话有交付上下文但依赖无任何关联 → 旧判据', () => {
    const v = evaluateDependencyGate(
      input({
        sessionDeliveryId: 'del-1',
        dependencies: [dep({ deliveryIds: [], prAggregate: 'reviewing' })],
        deliveries: [delivery()],
      }),
    )
    expect(v).toMatchObject({ reason: 'not_on_mainline' })
  })
})

describe('gateWantsPrStatusSync', () => {
  const verdictOf = (
    reason: 'pr_unmerged' | 'delivery_not_delivered' | 'not_done' | 'not_on_mainline',
  ) => ({ blocked: true, reason, dependency: { id: 'a', title: 'a' }, delivery: null }) as const

  it('两个 PR 形状的阻塞都触发同步(陈旧 reviewing 行是最常见的假阻塞)', () => {
    expect(gateWantsPrStatusSync(verdictOf('pr_unmerged'))).toBe(true)
    expect(gateWantsPrStatusSync(verdictOf('not_on_mainline'))).toBe(true)
  })

  it('交付未发布与依赖未完成都不触发:没有 forge 调用能改变它们', () => {
    expect(gateWantsPrStatusSync(verdictOf('delivery_not_delivered'))).toBe(false)
    expect(gateWantsPrStatusSync(verdictOf('not_done'))).toBe(false)
    expect(gateWantsPrStatusSync({ blocked: false })).toBe(false)
  })
})
