/**
 * 意图的基准分支:它是一个**快照**,不是每次读的时候现算的推导。
 *
 * 这里钉三件事:
 *  1. 落库的值从哪来 —— 配置 > 仓库探测 > main/master 约定,一条链,不允许出现第二套;
 *  2. 它在生命周期的哪些边沿会变 —— 创建、首次关联就绪交付、交付分支由未就绪变就绪、
 *     失去最后一条关联。除此以外一律不动,尤其是多交付关联不按关联顺序改写;
 *  3. 两个消费点 (PR 目标、worktree 基线) 读到的是同一个值 —— 这正是本列存在的理由:
 *     在此之前它们各推导各的,缺省主分支时的回退结果都不一样。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Delivery } from '@ccc/shared/protocol'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import { addWorkspace } from '../../state.js'
import {
  adoptReadyDeliveryBranchAsIntentBase,
  createDelivery,
  deleteIntentDelivery,
  getDelivery,
  insertIntentDelivery,
  resetStoreForTests as resetDeliveryStoreForTests,
  setDeliveryBranch,
} from '../deliveries/store.js'
import { resolveWorkspaceBaseBranch } from './base-branch.js'
import { resolvePrTarget } from './pr-target.js'
import {
  createEmptyIntent,
  getIntent,
  insertIntents,
  resetStoreForTests,
  upsertIntents,
} from './store.js'
import { resolveWorktreeBaseline } from './worktree-baseline.js'
import { fetchRemoteBase } from './worktree.js'

vi.mock('./worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worktree.js')>()),
  fetchRemoteBase: vi.fn(() => null),
}))

let home: string
let proj: string

/** A git repo whose default branch is `branch`, with one commit. */
function createGitRepo(dir: string, branch = 'main'): void {
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  run('init', '-b', branch)
  run('config', 'user.email', 'test@test')
  run('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), '# test')
  run('add', '-A')
  run('commit', '-m', 'initial')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-base-branch-'))
  process.env.C3_DIR = join(home, 'c3home')
  process.env.C3_DB_PATH = join(home, 'c3.db')
  proj = join(home, 'repo')
  execFileSync('mkdir', ['-p', proj])
  createGitRepo(proj)
  addWorkspace(proj, 1)
  resetDbForTests()
  resetSettingsCacheForTests()
  resetStoreForTests()
  resetDeliveryStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  resetSettingsCacheForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(home, { recursive: true, force: true })
  vi.clearAllMocks()
})

const seedIntent = (title = 'T'): string =>
  insertIntents(proj, [{ title, shortEnTitle: title, content: '', priority: 'P2' }])[0].id

/** A delivery in THIS workspace; `branch` also marks it ready when given. */
function seedDelivery(title: string, branch?: string): Delivery {
  const { delivery } = createDelivery({
    workspacePath: proj,
    title,
    description: '',
    startDate: null,
    endDate: null,
    baseBranch: 'main',
  })
  return branch ? setDeliveryBranch(delivery.id, branch, true)! : delivery
}

/** Link through the same value the handler passes: the delivery's ready branch. */
function link(delivery: Delivery, intentId: string): void {
  const fresh = getDelivery(delivery.id)!
  insertIntentDelivery(
    fresh.id,
    intentId,
    fresh.branchReady ? (fresh.branchName?.trim() ?? null) : null,
  )
}

describe('resolveWorkspaceBaseBranch — 一条解析链', () => {
  it('工作区显式配置的主分支优先,不去问 git', () => {
    saveWorkspaceSetting(proj, { defaultMainBranch: 'develop' })
    expect(resolveWorkspaceBaseBranch(proj)).toBe('develop')
  })

  it('没有配置 → 探测 origin/HEAD', () => {
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], {
      cwd: proj,
      stdio: 'ignore',
    })
    expect(resolveWorkspaceBaseBranch(proj)).toBe('trunk')
  })

  it('没有配置也没有 origin/HEAD → 当前分支', () => {
    expect(resolveWorkspaceBaseBranch(proj)).toBe('main')
  })

  it('完全探测不出来(非 git 目录)→ 落约定的 main', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'c3-non-git-'))
    try {
      expect(resolveWorkspaceBaseBranch(nonGit)).toBe('main')
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('探测不出来但仓库里只有 master → 落 master,不硬塞一个不存在的 main', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'c3-legacy-'))
    try {
      createGitRepo(legacy, 'master')
      // 游离 HEAD:没有当前分支可读,探测链走到尽头。
      execFileSync('git', ['checkout', '--detach'], { cwd: legacy, stdio: 'ignore' })
      expect(resolveWorkspaceBaseBranch(legacy)).toBe('master')
    } finally {
      rmSync(legacy, { recursive: true, force: true })
    }
  })
})

describe('创建意图 → 落基准分支快照', () => {
  it('insertIntents 落工作区主分支,并作为持久事实读出(不是读时回退)', () => {
    saveWorkspaceSetting(proj, { defaultMainBranch: 'develop' })
    const intent = getIntent(seedIntent())!
    expect(intent.baseBranch).toBe('develop')
    expect(intent.baseBranchFallback).toBe(false)
  })

  it('upsertIntents 新建与 createEmptyIntent 走同一条解析链', () => {
    saveWorkspaceSetting(proj, { defaultMainBranch: 'develop' })
    const upserted = upsertIntents(proj, [
      { title: 'U', shortEnTitle: 'u', content: '', priority: 'P2' },
    ])[0]
    expect(upserted.baseBranch).toBe('develop')
    expect(createEmptyIntent(proj).baseBranch).toBe('develop')
  })

  it('配置缺失时用探测结果,而不是字面量 main', () => {
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], {
      cwd: proj,
      stdio: 'ignore',
    })
    expect(getIntent(seedIntent())!.baseBranch).toBe('trunk')
  })

  it('改文本不重新取快照 —— 编辑意图不等于换了基准', () => {
    const id = seedIntent()
    saveWorkspaceSetting(proj, { defaultMainBranch: 'develop' })
    upsertIntents(proj, [{ id, title: 'T2', shortEnTitle: 't2', content: 'x', priority: 'P2' }])
    expect(getIntent(id)!.baseBranch).toBe('main')
  })
})

describe('交付关联生命周期', () => {
  it('首次关联分支已就绪的交付 → 快照改为该交付分支', () => {
    const id = seedIntent()
    link(seedDelivery('D1', 'delivery/alpha'), id)
    expect(getIntent(id)!.baseBranch).toBe('delivery/alpha')
  })

  it('交付分支未就绪 → 不写空值,保留主分支快照', () => {
    const id = seedIntent()
    link(seedDelivery('D1'), id)
    expect(getIntent(id)!.baseBranch).toBe('main')
  })

  it('未就绪交付随后就绪 → 只关联它的意图追平一次', () => {
    const id = seedIntent()
    const d = seedDelivery('D1')
    link(d, id)
    setDeliveryBranch(d.id, 'delivery/alpha', true)

    expect(adoptReadyDeliveryBranchAsIntentBase(d.id, 'delivery/alpha')).toEqual([id])
    expect(getIntent(id)!.baseBranch).toBe('delivery/alpha')
  })

  it('追平是幂等的:重复的就绪事件写同一个值', () => {
    const id = seedIntent()
    const d = seedDelivery('D1')
    link(d, id)
    setDeliveryBranch(d.id, 'delivery/alpha', true)
    adoptReadyDeliveryBranchAsIntentBase(d.id, 'delivery/alpha')
    adoptReadyDeliveryBranchAsIntentBase(d.id, 'delivery/alpha')
    expect(getIntent(id)!.baseBranch).toBe('delivery/alpha')
  })

  it('已解除关联的意图不被追平', () => {
    const id = seedIntent()
    const d = seedDelivery('D1')
    link(d, id)
    deleteIntentDelivery(d.id, id, 'main')
    setDeliveryBranch(d.id, 'delivery/alpha', true)

    expect(adoptReadyDeliveryBranchAsIntentBase(d.id, 'delivery/alpha')).toEqual([])
    expect(getIntent(id)!.baseBranch).toBe('main')
  })

  it('已关联第二个交付的意图不被追平 —— 谁是基准不是就绪事件能回答的', () => {
    const id = seedIntent()
    const d1 = seedDelivery('D1')
    link(d1, id)
    link(seedDelivery('D2', 'delivery/beta'), id)
    setDeliveryBranch(d1.id, 'delivery/alpha', true)

    expect(adoptReadyDeliveryBranchAsIntentBase(d1.id, 'delivery/alpha')).toEqual([])
    expect(getIntent(id)!.baseBranch).toBe('main')
  })

  it('第二个交付关联进来 → 保持已设值,不按关联顺序改写', () => {
    const id = seedIntent()
    link(seedDelivery('D1', 'delivery/alpha'), id)
    link(seedDelivery('D2', 'delivery/beta'), id)
    expect(getIntent(id)!.baseBranch).toBe('delivery/alpha')
  })

  it('解除最后一条关联 → 回退工作区主分支', () => {
    saveWorkspaceSetting(proj, { defaultMainBranch: 'develop' })
    const id = seedIntent()
    const d = seedDelivery('D1', 'delivery/alpha')
    link(d, id)

    deleteIntentDelivery(d.id, id, resolveWorkspaceBaseBranch(proj))
    expect(getIntent(id)!.baseBranch).toBe('develop')
  })

  it('还有其它关联时解除一条 → 保持已设值', () => {
    const id = seedIntent()
    const d1 = seedDelivery('D1', 'delivery/alpha')
    const d2 = seedDelivery('D2', 'delivery/beta')
    link(d1, id)
    link(d2, id)

    deleteIntentDelivery(d2.id, id, 'main')
    expect(getIntent(id)!.baseBranch).toBe('delivery/alpha')
  })

  it('关联边写入失败(重复关联)不改快照', () => {
    const id = seedIntent()
    const d1 = seedDelivery('D1', 'delivery/alpha')
    link(d1, id)
    // 同一条边再插一次:被拒,且不得把快照重写成任何东西。
    expect(insertIntentDelivery(d1.id, id, 'delivery/other')).toBe(false)
    expect(getIntent(id)!.baseBranch).toBe('delivery/alpha')
  })
})

describe('两个消费点读同一个持久值', () => {
  it('PR 目标与 worktree 基线在关联前后都一致', () => {
    const id = seedIntent()
    const before = getIntent(id)!
    expect(resolvePrTarget(proj, before, undefined)).toEqual({
      ok: true,
      deliveryId: null,
      baseBranch: 'main',
    })
    expect(resolveWorktreeBaseline(proj, before, null).baseBranch).toBe('main')

    const d = seedDelivery('D1', 'delivery/alpha')
    link(d, id)
    const after = getIntent(id)!
    const target = resolvePrTarget(proj, after, undefined)
    expect(target).toEqual({ ok: true, deliveryId: d.id, baseBranch: 'delivery/alpha' })
    expect(resolveWorktreeBaseline(proj, after, getDelivery(d.id)).baseBranch).toBe(
      'delivery/alpha',
    )
  })

  it('未就绪 → 就绪:追平前两个消费点同为主线,追平后同为交付分支', () => {
    const id = seedIntent()
    const d = seedDelivery('D1')
    link(d, id)

    const before = getIntent(id)!
    expect(resolveWorktreeBaseline(proj, before, getDelivery(d.id)).baseBranch).toBe('main')
    // 分支未就绪时建 PR 仍被既有守卫拒绝,与本变更无关。
    expect(resolvePrTarget(proj, before, undefined)).toEqual({
      ok: false,
      code: 'delivery.guard.branchNotReady',
    })

    setDeliveryBranch(d.id, 'delivery/alpha', true)
    adoptReadyDeliveryBranchAsIntentBase(d.id, 'delivery/alpha')
    const after = getIntent(id)!
    expect(resolveWorktreeBaseline(proj, after, getDelivery(d.id)).baseBranch).toBe(
      'delivery/alpha',
    )
    expect(resolvePrTarget(proj, after, undefined)).toMatchObject({
      ok: true,
      baseBranch: 'delivery/alpha',
    })
  })

  it('多交付:歧义仍要人工选,选定的交付分支才是 PR base', () => {
    const id = seedIntent()
    const d1 = seedDelivery('D1', 'delivery/alpha')
    const d2 = seedDelivery('D2', 'delivery/beta')
    link(d1, id)
    link(d2, id)
    const intent = getIntent(id)!

    expect(resolvePrTarget(proj, intent, undefined)).toEqual({
      ok: false,
      code: 'delivery.prCreateAmbiguous',
    })
    expect(resolvePrTarget(proj, intent, d2.id)).toEqual({
      ok: true,
      deliveryId: d2.id,
      baseBranch: 'delivery/beta',
    })
    // 快照本身不因这次选择而改写。
    expect(getIntent(id)!.baseBranch).toBe('delivery/alpha')
  })

  it('worktree 基线用快照 fetch,而不是当前交付分支', () => {
    const id = seedIntent()
    link(seedDelivery('D1', 'delivery/alpha'), id)
    resolveWorktreeBaseline(proj, getIntent(id)!, null)
    expect(fetchRemoteBase).toHaveBeenCalledWith(proj, 'delivery/alpha')
  })
})

describe('存量回填', () => {
  /**
   * 造一个「列已存在但值为空」的库:回填标记删掉后重新 ensure,等价于升级到本版本
   * 那一刻的存量状态。
   */
  function reopenWithBlankBaseBranch(): void {
    const raw = getDb()!
    raw.run('UPDATE intents SET base_branch=NULL')
    raw.run("DELETE FROM schema_migrations WHERE id='intents.backfill_base_branch.v1'")
    resetStoreForTests()
  }

  it('无关联 → 回填工作区主分支', () => {
    const id = seedIntent()
    saveWorkspaceSetting(proj, { defaultMainBranch: 'develop' })
    reopenWithBlankBaseBranch()
    expect(getIntent(id)!.baseBranch).toBe('develop')
  })

  it('恰好一个已就绪交付 → 回填该交付分支', () => {
    const id = seedIntent()
    link(seedDelivery('D1', 'delivery/alpha'), id)
    reopenWithBlankBaseBranch()
    expect(getIntent(id)!.baseBranch).toBe('delivery/alpha')
  })

  it('唯一交付未就绪 → 绝不写入未就绪分支,落主分支', () => {
    const id = seedIntent()
    link(seedDelivery('D1'), id)
    reopenWithBlankBaseBranch()
    expect(getIntent(id)!.baseBranch).toBe('main')
  })

  it('多交付 → 不按关联顺序猜,落主分支', () => {
    const id = seedIntent()
    link(seedDelivery('D1', 'delivery/alpha'), id)
    link(seedDelivery('D2', 'delivery/beta'), id)
    reopenWithBlankBaseBranch()
    expect(getIntent(id)!.baseBranch).toBe('main')
  })

  it('已有有效值的行不动;标记落定后不再重复回填', () => {
    const id = seedIntent()
    const raw = getDb()!
    raw.run('UPDATE intents SET base_branch=? WHERE id=?', 'kept/branch', id)
    raw.run("DELETE FROM schema_migrations WHERE id='intents.backfill_base_branch.v1'")
    resetStoreForTests()
    expect(getIntent(id)!.baseBranch).toBe('kept/branch')

    // 标记已写:此后即便把值清空,也不会再有第二次回填(读时回退兜住展示)。
    raw.run('UPDATE intents SET base_branch=NULL')
    resetStoreForTests()
    const intent = getIntent(id)!
    expect(intent.baseBranch).toBe('main')
    expect(intent.baseBranchFallback).toBe(true)
    expect(
      raw.get<{ base_branch: string | null }>('SELECT base_branch FROM intents WHERE id=?', id),
    ).toEqual({ base_branch: null })
  })
})
