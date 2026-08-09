/**
 * 意图沟通 / 规范撰写 / 规范评审三类会话与开发会话共用同一个意图 worktree。
 *
 * 这里钉的是四件事,少一件这次改动就白做:
 * 1. 三类前置会话的 `effectiveCwd` 真的落在 `getWorktreePath(workspace, intentId)`,
 *    而不是主 checkout —— 否则代理仍然在看错分支的代码;
 * 2. 四类会话共用同一个目录,先到者建、后到者复用,不会冒出第二个 worktree;
 * 3. 共用目录 ≠ 共用写权限:规范文档仍然落集中式 spec 根,worktree 里不出现规范文件;
 * 4. worktree 已存在但不在目标基线上时,四类会话照常启动,只额外收到一条提示,并按
 *    干净/脏给出「可重建 / 只能先提交」两种修复出口 —— 目录从不被自动改写。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests, getDb } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { getRuntime, removeRuntimesForWorkspace } from '../../runs.js'
import { getIntent, insertIntents, resetStoreForTests, setSpecPath, updateStatus } from './store.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import { resetStoreForTests as resetSessionMetadata } from '../sessions/session-metadata-store.js'
import { resetForTests as resetIntentLink } from './intent-link.js'
import { resetForTests as resetSpecLink } from './spec-link.js'
import { resetForTests as resetSpecReviewLink } from './spec-review-link.js'
// 意图沟通会话的回执要过一次 enrichRunStatus,它读 wait_user_involve_events —— 这张
// 表按需建,不初始化就查不到。
import { resetStoreForTests as resetUserInvolveStore } from '../user-involve/store.js'
import { refineIntent } from './index.js'
import {
  launchSpecReviewSession,
  launchSpecSession,
  launchWorkSession,
  type SessionLaunchDeps,
  type SessionLaunchResult,
} from './session-launcher.js'
import type { WorktreeBaselineNotice } from './session-worktree.js'
import { generateBranchName, getWorktreeBase, getWorktreePath } from './worktree.js'
import { getSpecsBase } from './specs-root.js'

let dir: string
let bare: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/**
 * 一个带真实 origin 的仓库。基线检查只认「刚 fetch 到的远端 ref」,没有远端就一律
 * 放行,所以要覆盖「拦下」这条路径就必须有裸远端。
 */
function seedRepoWithRemote(): void {
  bare = mkdtempSync(join(tmpdir(), 'c3-session-wt-bare-'))
  git(bare, 'init', '--bare', '-b', 'main')
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@test')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'initial')
  git(dir, 'remote', 'add', 'origin', bare)
  git(dir, 'push', '-u', 'origin', 'main')
}

/** 造一条 worktree 不可能包含的远端分支,用来制造基线失配。 */
function pushDivergedBranch(branch: string): void {
  const clone = mkdtempSync(join(tmpdir(), 'c3-session-wt-clone-'))
  execFileSync('git', ['clone', bare, clone], { stdio: 'ignore' })
  git(clone, 'config', 'user.email', 'other@test')
  git(clone, 'config', 'user.name', 'Other')
  git(clone, 'checkout', '-b', branch)
  writeFileSync(join(clone, 'DIVERGED.md'), 'only on the other branch\n', 'utf8')
  git(clone, 'add', '-A')
  git(clone, 'commit', '-m', 'diverged')
  git(clone, 'push', 'origin', branch)
  rmSync(clone, { recursive: true, force: true })
}

/** 把意图的持久基准分支改成 `branch` —— 由前置依赖落库,这里直接设值。 */
function setBaseBranch(intentId: string, branch: string): void {
  getDb()!.run('UPDATE intents SET base_branch=? WHERE id=?', branch, intentId)
  resetStoreForTests()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-session-worktree-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  seedRepoWithRemote()
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetIntentLink()
  resetSpecLink()
  resetSpecReviewLink()
  resetUserInvolveStore()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
  // SDD 关闭:这些用例钉的是目录,不是规范批准闸门 —— 否则开发会话会先撞
  // `intent.specNotApproved`,测不到 worktree 守卫。
  saveWorkspaceSetting(proj, {
    gitBranchMode: 'worktree',
    defaultMainBranch: 'main',
    sddEnabled: false,
  })
})

afterEach(() => {
  removeRuntimesForWorkspace(proj)
  resetDbForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetIntentLink()
  resetSpecLink()
  resetSpecReviewLink()
  delete process.env.CLAUDE_CONFIG_DIR
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
})

function mockDeps(): SessionLaunchDeps {
  return {
    launchRun: vi.fn().mockResolvedValue(undefined) as unknown as SessionLaunchDeps['launchRun'],
    broadcastIntents: vi.fn(),
  }
}

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    subject: 'alice',
    authed: true,
    authToken: null,
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
  } as unknown as Conn
  return { conn, sent }
}

function ctx(): KernelContext {
  return {
    launchRun: vi.fn().mockResolvedValue(undefined),
    broadcastIntents: vi.fn(),
  } as unknown as KernelContext
}

function seedIntent(title = 'Target'): string {
  const [intent] = insertIntents(proj, [
    { title, shortEnTitle: 'target', content: 'body', priority: 'P1' },
  ])
  return intent.id
}

/** 让意图具备启动评审会话的前提:一个真实存在的 spec 文件。 */
function seedSpecFile(intentId: string): string {
  const fileAbs = join(getSpecsBase(proj), '2026', '08', '08', 'spec.md')
  execFileSync('mkdir', ['-p', join(getSpecsBase(proj), '2026', '08', '08')])
  writeFileSync(fileAbs, '# spec\n\nbody\n', 'utf8')
  setSpecPath(intentId, fileAbs)
  return fileAbs
}

function asSuccess(r: SessionLaunchResult): { sessionId: string } {
  expect(r.success).toBe(true)
  return r as { sessionId: string; success: true }
}

function asError(r: SessionLaunchResult): { code: string; params?: Record<string, string> } {
  expect(r.success).toBe(false)
  return r as { success: false; code: string; params?: Record<string, string> }
}

/** 一次成功启动随身带回的基线提示;没有提示即用例本身没造出失配。 */
function baselineNotice(r: SessionLaunchResult): WorktreeBaselineNotice {
  expect(r.success).toBe(true)
  const notice = r.success ? r.baselineNotice : undefined
  expect(notice).toBeTruthy()
  return notice!
}

/** 从 `session_selected` 回执里取会话 id。 */
function selectedId(sent: ServerToClient[]): string {
  const m = sent.find((x) => x.type === 'session_selected')
  expect(m).toBeTruthy()
  return m && m.type === 'session_selected' ? m.sessionId : ''
}

// ---------------------------------------------------------------------------
// 1. 三类前置会话的 cwd
// ---------------------------------------------------------------------------

describe('worktree 模式:意图/规范/评审会话都在意图 worktree 里跑', () => {
  it('意图沟通会话的 effectiveCwd 指向意图 worktree', async () => {
    const id = seedIntent()
    const { conn, sent } = fakeConn()
    await refineIntent(ctx(), conn, { type: 'refine_intent', workspaceId, intentId: id })

    const rt = getRuntime(selectedId(sent))!
    expect(rt.effectiveCwd).toBe(getWorktreePath(proj, id))
    expect(existsSync(getWorktreePath(proj, id))).toBe(true)
  })

  it('规范撰写会话的 effectiveCwd 指向意图 worktree', async () => {
    const id = seedIntent()
    const r = asSuccess(await launchSpecSession(proj, id, mockDeps()))
    expect(getRuntime(r.sessionId)!.effectiveCwd).toBe(getWorktreePath(proj, id))
  })

  it('规范评审会话的 effectiveCwd 指向意图 worktree', async () => {
    const id = seedIntent()
    seedSpecFile(id)
    const r = asSuccess(await launchSpecReviewSession(proj, id, mockDeps()))
    expect(getRuntime(r.sessionId)!.effectiveCwd).toBe(getWorktreePath(proj, id))
  })

  it('worktree 建在意图持久化的基准分支上,而不是当前 checkout 的 HEAD', async () => {
    const id = seedIntent()
    pushDivergedBranch('delivery/v9')
    setBaseBranch(id, 'delivery/v9')

    asSuccess(await launchSpecSession(proj, id, mockDeps()))
    // 只有 delivery/v9 上才有这个文件:worktree 确实以该分支为根。
    expect(existsSync(join(getWorktreePath(proj, id), 'DIVERGED.md'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. 共用一个目录
// ---------------------------------------------------------------------------

describe('四类会话共用同一个意图 worktree', () => {
  it('规范会话先建、评审与开发会话复用,自始至终只有一个目录', async () => {
    const id = seedIntent()
    seedSpecFile(id)
    const expected = getWorktreePath(proj, id)

    asSuccess(await launchSpecSession(proj, id, mockDeps()))
    const afterSpec = readdirSync(getWorktreeBase(proj))

    const review = asSuccess(await launchSpecReviewSession(proj, id, mockDeps()))
    const work = asSuccess(await launchWorkSession(proj, id, mockDeps()))

    expect(getRuntime(review.sessionId)!.effectiveCwd).toBe(expected)
    expect(getRuntime(work.sessionId)!.effectiveCwd).toBe(expected)
    // 没有第二个 worktree 目录被创建。
    expect(readdirSync(getWorktreeBase(proj))).toEqual(afterSpec)
    expect(afterSpec).toHaveLength(1)
  })

  it('规范会话 resume 复用同一 worktree,不重建', async () => {
    const id = seedIntent()
    const first = asSuccess(await launchSpecSession(proj, id, mockDeps()))
    // 让它成为一个「已绑定」的会话,这样第二次调用走 resume 分支。
    const before = readdirSync(getWorktreeBase(proj))

    const again = await launchSpecSession(proj, id, mockDeps())
    expect(again.success).toBe(true)
    expect(readdirSync(getWorktreeBase(proj))).toEqual(before)
    expect(getRuntime(first.sessionId)!.effectiveCwd).toBe(getWorktreePath(proj, id))
  })
})

// ---------------------------------------------------------------------------
// 3. 共用目录 ≠ 共用写权限
// ---------------------------------------------------------------------------

describe('规范文档仍写集中式 spec 根,不进 worktree', () => {
  it('spec 会话的写入根是 specs 根,worktree 里没有规范文件', async () => {
    const id = seedIntent()
    const r = asSuccess(await launchSpecSession(proj, id, mockDeps()))
    const rt = getRuntime(r.sessionId)!

    // 读代码的根和写文档的根是两个独立概念。
    expect(rt.effectiveCwd).toBe(getWorktreePath(proj, id))
    expect(rt.specDir!.startsWith(getSpecsBase(proj))).toBe(true)
    expect(rt.specDir!.startsWith(getWorktreePath(proj, id))).toBe(false)
    expect(getIntent(id)!.specPath!.startsWith(getSpecsBase(proj))).toBe(true)
    // worktree 是刚从 main 拉出来的,只有仓库自身的文件 —— 没有任何 .md 规范落进来。
    expect(readdirSync(getWorktreePath(proj, id)).sort()).toEqual(['.git', 'README.md'])
  })

  it('评审会话不获得任何写入根', async () => {
    const id = seedIntent()
    seedSpecFile(id)
    const r = asSuccess(await launchSpecReviewSession(proj, id, mockDeps()))
    expect(getRuntime(r.sessionId)!.specDir).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. 基线守卫与修复出口
// ---------------------------------------------------------------------------

describe('基线失配:只提示不拦人,目录从不被自动改写', () => {
  /** 先在 main 上建好 worktree,再把意图的基准分支挪到一条它不可能包含的分支。 */
  async function seedMismatch(): Promise<string> {
    const id = seedIntent()
    asSuccess(await launchSpecSession(proj, id, mockDeps()))
    pushDivergedBranch('delivery/v9')
    setBaseBranch(id, 'delivery/v9')
    return id
  }

  it('干净 worktree:会话照常启动,提示里给出可重建的出口', async () => {
    const id = await seedMismatch()
    const n = baselineNotice(await launchSpecReviewSession(proj, id, mockDeps()))
    expect(n.branch).toBe('delivery/v9')
    expect(n.canRebuild).toBe(true)
  })

  // 提示要能回答「为什么不匹配」:这个目录当初就建在 main 上,不是基准分支推进
  // 把它甩在后面 —— 两者的修复动作一样,但原因不同,用户得能分辨。
  it('提示带上 worktree 当前实际基线(分支 + HEAD)', async () => {
    const id = await seedMismatch()
    const n = baselineNotice(await launchSpecReviewSession(proj, id, mockDeps()))
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: getWorktreePath(proj, id),
      encoding: 'utf-8',
    }).trim()
    expect(n.currentBranch).toBe(generateBranchName(id, 'Target'))
    expect(n.currentHead).toBe(head)
  })

  it('有未提交改动:照样启动,但提示里不给重建这个出口', async () => {
    const id = await seedMismatch()
    writeFileSync(join(getWorktreePath(proj, id), 'dirty.txt'), 'uncommitted\n', 'utf8')
    expect(baselineNotice(await launchSpecReviewSession(proj, id, mockDeps())).canRebuild).toBe(
      false,
    )
  })

  it('意图沟通会话照常起,提示随回执一起到,且不是 error', async () => {
    const id = await seedMismatch()
    const { conn, sent } = fakeConn()
    await refineIntent(ctx(), conn, { type: 'refine_intent', workspaceId, intentId: id })

    expect(sent.some((m) => m.type === 'error')).toBe(false)
    expect(sent.some((m) => m.type === 'session_selected')).toBe(true)
    const notice = sent.find((m) => m.type === 'intent_worktree_baseline_notice')
    expect(notice && notice.type === 'intent_worktree_baseline_notice' ? notice.branch : '').toBe(
      'delivery/v9',
    )
  })

  it('开发会话同样只收到提示 —— 四类会话共用这一条判定', async () => {
    const id = await seedMismatch()
    expect(baselineNotice(await launchWorkSession(proj, id, mockDeps())).branch).toBe('delivery/v9')
  })

  it('基线不符时 worktree 原样保留,未提交产物不丢', async () => {
    const id = await seedMismatch()
    const keep = join(getWorktreePath(proj, id), 'work-in-progress.txt')
    writeFileSync(keep, 'do not lose me\n', 'utf8')
    await launchSpecReviewSession(proj, id, mockDeps())
    await launchSpecSession(proj, id, mockDeps())
    expect(existsSync(keep)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. current-branch 模式不受影响
// ---------------------------------------------------------------------------

describe('current-branch 模式:不建意图 worktree', () => {
  beforeEach(() => {
    saveWorkspaceSetting(proj, {
      gitBranchMode: 'current-branch',
      defaultMainBranch: 'main',
      sddEnabled: false,
    })
  })

  it('规范会话留在主 checkout,worktree 根下什么都没有', async () => {
    const id = seedIntent()
    const r = asSuccess(await launchSpecSession(proj, id, mockDeps()))
    expect(getRuntime(r.sessionId)!.effectiveCwd).toBe(proj)
    expect(existsSync(getWorktreePath(proj, id))).toBe(false)
  })

  it('评审会话同样留在主 checkout', async () => {
    const id = seedIntent()
    seedSpecFile(id)
    const r = asSuccess(await launchSpecReviewSession(proj, id, mockDeps()))
    expect(getRuntime(r.sessionId)!.effectiveCwd).toBe(proj)
  })
})

// ---------------------------------------------------------------------------
// 6. 目录事实不等于开发事实
// ---------------------------------------------------------------------------

describe('先建目录的前置会话不把意图伪装成「已开工」', () => {
  it('规范会话建了 worktree,但 branch_name 仍为空,直到开发会话真正启动', async () => {
    const id = seedIntent()
    asSuccess(await launchSpecSession(proj, id, mockDeps()))
    expect(getIntent(id)!.branchName ?? '').toBe('')

    updateStatus(id, 'todo', 'test')
    asSuccess(await launchWorkSession(proj, id, mockDeps()))
    expect(getIntent(id)!.branchName).toBeTruthy()
  })
})
