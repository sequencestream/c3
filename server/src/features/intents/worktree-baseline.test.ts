/**
 * worktree 基线:选谁做基线,以及「检测不出来」时必须放行而不是拦人。
 *
 * 这里的每一条都是在钉同一件事:c3 从不自动重建 worktree、从不暗中 merge,所以
 * 它对基线的判断只有在**确凿**时才允许拦下一次启动。任何测不出来的情形(远端不
 * 可解析、worktree 还不存在、交付分支未就绪)都必须是放行,否则用户会被一个根本
 * 不存在的分支挡在修复弹窗前面。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Delivery, Intent } from '@ccc/shared/protocol'
import { checkExistingWorktreeBaseline, resolveWorktreeBaseline } from './worktree-baseline.js'
import {
  fetchRemoteBase,
  isWorktreeClean,
  readWorktreeHead,
  worktreeContainsRef,
  worktreeExists,
} from './worktree.js'

vi.mock('./worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worktree.js')>()),
  fetchRemoteBase: vi.fn(),
  worktreeExists: vi.fn(),
  worktreeContainsRef: vi.fn(),
  isWorktreeClean: vi.fn(),
  readWorktreeHead: vi.fn(),
}))

const delivery = (over: Partial<Delivery> = {}): Delivery =>
  ({
    id: 'd1',
    workspaceId: 'w',
    title: '交付 X',
    description: '',
    status: 'integrating',
    startDate: null,
    endDate: null,
    branchName: 'delivery/sprint-3',
    baseBranch: 'main',
    branchReady: true,
    integration: { merged: 0, total: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as Delivery

/** Only the field the baseline reads — the persisted snapshot. */
const intent = (baseBranch: string): Intent => ({ id: 'i1', baseBranch }) as Intent

beforeEach(() => {
  vi.mocked(fetchRemoteBase).mockReturnValue('origin/delivery/sprint-3')
  vi.mocked(worktreeExists).mockReturnValue(true)
  vi.mocked(worktreeContainsRef).mockReturnValue(true)
  vi.mocked(isWorktreeClean).mockReturnValue(true)
  vi.mocked(readWorktreeHead).mockReturnValue({ branch: 'main', head: 'abc1234' })
})

afterEach(() => vi.clearAllMocks())

describe('resolveWorktreeBaseline', () => {
  it('基线取意图持久化的基准分支,不从当前交付重新推导', () => {
    const b = resolveWorktreeBaseline('/w', intent('delivery/sprint-3'), delivery())
    expect(b.baseBranch).toBe('delivery/sprint-3')
    expect(b.offDeliveryBranch).toBe(false)
    expect(b.delivery).toEqual({ id: 'd1', title: '交付 X' })
    expect(fetchRemoteBase).toHaveBeenCalledWith('/w', 'delivery/sprint-3')
  })

  it('交付分支未就绪 → 意图快照仍是主线,标记回退(不是拒绝)', () => {
    const b = resolveWorktreeBaseline('/w', intent('main'), delivery({ branchReady: false }))
    expect(b.baseBranch).toBe('main')
    expect(b.offDeliveryBranch).toBe(true)
    expect(b.delivery).toEqual({ id: 'd1', title: '交付 X' })
  })

  it('无交付上下文 → 用意图快照,不标记回退', () => {
    const b = resolveWorktreeBaseline('/w', intent('main'), null)
    expect(b.baseBranch).toBe('main')
    expect(b.offDeliveryBranch).toBe(false)
    expect(b.delivery).toBeNull()
  })

  it('快照与当前交付分支不一致(多交付)→ 仍以快照为准,并标记这不是交付分支', () => {
    const b = resolveWorktreeBaseline('/w', intent('delivery/other'), delivery())
    expect(b.baseBranch).toBe('delivery/other')
    expect(b.offDeliveryBranch).toBe(true)
    expect(fetchRemoteBase).toHaveBeenCalledWith('/w', 'delivery/other')
  })
})

describe('checkExistingWorktreeBaseline', () => {
  const baseline = (over: Partial<ReturnType<typeof resolveWorktreeBaseline>> = {}) => ({
    baseBranch: 'delivery/sprint-3',
    remoteRef: 'origin/delivery/sprint-3',
    delivery: { id: 'd1', title: '交付 X' },
    offDeliveryBranch: false,
    ...over,
  })

  it('worktree 已包含基线 → 放行', () => {
    expect(checkExistingWorktreeBaseline('/w', 'i1', baseline())).toBeNull()
  })

  it('worktree 尚不存在 → 放行(它会以基线新建)', () => {
    vi.mocked(worktreeExists).mockReturnValue(false)
    expect(checkExistingWorktreeBaseline('/w', 'i1', baseline())).toBeNull()
  })

  it('远端引用取不到(离线 / 分支从未推送)→ 放行,绝不误报', () => {
    expect(checkExistingWorktreeBaseline('/w', 'i1', baseline({ remoteRef: null }))).toBeNull()
  })

  it('祖先判断给不出结论 → 放行:测不出来不等于违规', () => {
    vi.mocked(worktreeContainsRef).mockReturnValue(null)
    expect(checkExistingWorktreeBaseline('/w', 'i1', baseline())).toBeNull()
  })

  it('确凿不符且 worktree 干净 → 阻塞,并允许安全重建', () => {
    vi.mocked(worktreeContainsRef).mockReturnValue(false)
    expect(checkExistingWorktreeBaseline('/w', 'i1', baseline())).toEqual({
      branch: 'delivery/sprint-3',
      delivery: { id: 'd1', title: '交付 X' },
      canRebuild: true,
      current: { branch: 'main', head: 'abc1234' },
    })
  })

  it('确凿不符且有未提交改动 → 阻塞,且不给重建这个出口', () => {
    vi.mocked(worktreeContainsRef).mockReturnValue(false)
    vi.mocked(isWorktreeClean).mockReturnValue(false)
    expect(checkExistingWorktreeBaseline('/w', 'i1', baseline())).toMatchObject({
      canRebuild: false,
    })
  })

  // 「建错基线」和「交付分支被推进」都走这一条拦截,报错必须能把两者区分开:
  // 前者 worktree 还坐在主线上,后者已经在自己的意图分支上。
  it('阻塞时带上 worktree 真实所在位置,便于区分建错基线与基线过期', () => {
    vi.mocked(worktreeContainsRef).mockReturnValue(false)
    vi.mocked(readWorktreeHead).mockReturnValue({ branch: 'intent/abc-x', head: 'deadbee' })
    expect(checkExistingWorktreeBaseline('/w', 'i1', baseline())).toMatchObject({
      current: { branch: 'intent/abc-x', head: 'deadbee' },
    })
  })

  it('HEAD 分离或读不出来时如实报 null,不拿主线冒充', () => {
    vi.mocked(worktreeContainsRef).mockReturnValue(false)
    vi.mocked(readWorktreeHead).mockReturnValue({ branch: null, head: null })
    expect(checkExistingWorktreeBaseline('/w', 'i1', baseline())).toMatchObject({
      current: { branch: null, head: null },
    })
  })
})
