/**
 * 会话的交付上下文:解析规则,以及它作为准入闸门输入时的三个后果 ——
 * 「多关联必须显式选定」「交付不可写就不给新写入」「依赖闸门可被知情放行且留审计」。
 *
 * 全部走真实的 intents / deliveries 仓储:这一段的价值恰恰在于两个 store 的关联事实
 * 被正确读出,把它们 mock 掉就等于把要证明的东西假设成立。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Intent } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import {
  getIntent,
  insertIntents,
  listIntentLogs,
  resetStoreForTests,
  setBranchName,
  updateIntentDeps,
  updateStatus,
} from './store.js'
import {
  createDelivery,
  insertIntentDelivery,
  resetStoreForTests as resetDeliveryStore,
  setDeliveryStatus,
} from '../deliveries/store.js'
import { impliedDeliveryContextId, resolveSessionDeliveryContext } from './delivery-context.js'
import { launchWorkSession, type SessionLaunchDeps } from './session-launcher.js'

// 依赖闸门阻塞时的后台 PR 刷新是 fire-and-forget 的 forge 调用,这里只关心闸门本身。
vi.mock('./pr-status-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pr-status-sync.js')>()),
  syncUnconfirmedDependencyPrsInBackground: vi.fn(),
}))
// worktree 基线检查会 fetch 远端;本文件测的是它之前的几道闸门。
vi.mock('./worktree-baseline.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worktree-baseline.js')>()),
  resolveWorktreeBaseline: vi.fn(() => ({
    baseBranch: 'main',
    remoteRef: null,
    delivery: null,
    fellBackToMainline: false,
  })),
  checkExistingWorktreeBaseline: vi.fn(() => null),
}))

let dir: string
let proj: string

const deps: SessionLaunchDeps = {
  launchRun: vi.fn(async () => {}),
  broadcastIntents: vi.fn(),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-delivery-context-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetDeliveryStore()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  proj = resolveWorkspaceRoot(pathToId(dir)!)!
  // SDD off: this file is about the DELIVERY gates, and an unapproved spec would
  // stop every launch at the gate above them.
  saveWorkspaceSetting(proj, {
    gitBranchMode: 'worktree',
    defaultMainBranch: 'main',
    sddEnabled: false,
  })
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

function seedIntent(title: string): Intent {
  const [r] = insertIntents(proj, [{ title, shortEnTitle: title, content: '', priority: 'P1' }])
  return getIntent(r.id)!
}

function seedDelivery(title: string, intentId?: string): { id: string; title: string } {
  const { delivery } = createDelivery({
    workspacePath: proj,
    title,
    description: '',
    startDate: null,
    endDate: null,
    baseBranch: 'main',
  })
  if (intentId) insertIntentDelivery(delivery.id, intentId)
  return { id: delivery.id, title: delivery.title }
}

describe('resolveSessionDeliveryContext', () => {
  it('无关联 → 无上下文(交付能力上线前的行为原样保留)', () => {
    const r = seedIntent('T')
    expect(resolveSessionDeliveryContext(proj, r)).toEqual({ ok: true, delivery: null })
  })

  it('恰好一个关联 → 自动带入(这是事实,不是猜测)', () => {
    const r = seedIntent('T')
    const d = seedDelivery('Sprint 3', r.id)
    const out = resolveSessionDeliveryContext(proj, getIntent(r.id)!)
    expect(out).toMatchObject({ ok: true })
    expect(out.ok && out.delivery?.id).toBe(d.id)
  })

  it('多个关联且未显式携带 → 明确拒绝,绝不默认取第一个', () => {
    const r = seedIntent('T')
    seedDelivery('A', r.id)
    seedDelivery('B', r.id)
    expect(resolveSessionDeliveryContext(proj, getIntent(r.id)!)).toEqual({
      ok: false,
      code: 'intent.deliveryContextRequired',
    })
  })

  it('多个关联但显式选定其一 → 通过', () => {
    const r = seedIntent('T')
    seedDelivery('A', r.id)
    const b = seedDelivery('B', r.id)
    const out = resolveSessionDeliveryContext(proj, getIntent(r.id)!, b.id)
    expect(out.ok && out.delivery?.id).toBe(b.id)
  })

  it('不存在的交付 id 被拒绝', () => {
    const r = seedIntent('T')
    seedDelivery('A', r.id)
    expect(resolveSessionDeliveryContext(proj, getIntent(r.id)!, 'ghost')).toEqual({
      ok: false,
      code: 'intent.deliveryContextUnknown',
    })
  })

  it('存在但未关联本意图的交付被拒绝 —— 不能借启动到达一个建 PR 都到不了的交付', () => {
    const r = seedIntent('T')
    const other = seedIntent('Other')
    seedDelivery('A', r.id)
    const foreign = seedDelivery('B', other.id)
    expect(resolveSessionDeliveryContext(proj, getIntent(r.id)!, foreign.id)).toEqual({
      ok: false,
      code: 'intent.deliveryContextNotLinked',
    })
  })
})

describe('impliedDeliveryContextId', () => {
  it('只有唯一关联时才隐含上下文;0 个与多个都是无', () => {
    expect(impliedDeliveryContextId({ linkedDeliveries: [] })).toBeNull()
    expect(impliedDeliveryContextId({ linkedDeliveries: [{ id: 'a', title: 'A' }] })).toBe('a')
    expect(
      impliedDeliveryContextId({
        linkedDeliveries: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
        ],
      }),
    ).toBeNull()
  })
})

describe('launchWorkSession —— 交付相关的准入闸门', () => {
  it('多关联未选定交付 → 明确报错而非默认启动', async () => {
    const r = seedIntent('T')
    seedDelivery('A', r.id)
    seedDelivery('B', r.id)
    const out = await launchWorkSession(proj, r.id, deps)
    expect(out).toEqual({ success: false, code: 'intent.deliveryContextRequired' })
  })

  it('交付处于 verifying 时拒绝新的写入会话', async () => {
    const r = seedIntent('T')
    const d = seedDelivery('A', r.id)
    setDeliveryStatus(d.id, 'verifying')
    const out = await launchWorkSession(proj, r.id, deps)
    expect(out).toMatchObject({ success: false, code: 'intent.deliveryNotWritable' })
  })

  it('交付处于 integrating 时该闸门不拦截(拒绝原因不再是交付状态)', async () => {
    const r = seedIntent('T')
    const d = seedDelivery('A', r.id)
    setDeliveryStatus(d.id, 'integrating')
    const out = await launchWorkSession(proj, r.id, deps)
    expect(out.success === false && out.code).not.toBe('intent.deliveryNotWritable')
  })

  /** 依赖 done、在自己的分支上、PR 未合入 —— 无交付路径下的经典阻塞。 */
  function seedBlockedByDependency(): Intent {
    const dep = seedIntent('Dep')
    const target = seedIntent('Target')
    updateIntentDeps(target.id, [{ dependsOnId: dep.id, depType: 'blocks' }])
    updateStatus(dep.id, 'done', 'test')
    setBranchName(dep.id, 'intent/dep')
    return getIntent(target.id)!
  }

  it('依赖闸门默认阻塞,并给出可解释的拒绝码', async () => {
    const target = seedBlockedByDependency()
    const out = await launchWorkSession(proj, target.id, deps)
    expect(out).toMatchObject({ success: false, code: 'intent.dependencyNotMerged' })
  })

  it('强制放行跳过依赖闸门,并留下带 actor 的审计记录', async () => {
    const target = seedBlockedByDependency()
    const out = await launchWorkSession(proj, target.id, deps, undefined, 'alice', {
      forceDependencyGate: true,
    })

    // 依赖闸门确实被跳过了:拒绝原因(如果有)不再是依赖闸门。
    expect(out.success === false && out.code).not.toBe('intent.dependencyNotMerged')

    const logs = listIntentLogs(target.id)
    const audit = logs.find((l) => l.operationType === 'dependency_gate_force_release')
    expect(audit).toBeTruthy()
    expect(audit!.actor).toBe('alice')
    expect(audit!.summary).toContain('Dep')
  })

  it('未被闸门拦下时,强制放行不会凭空写审计记录', async () => {
    const r = seedIntent('T')
    await launchWorkSession(proj, r.id, deps, undefined, 'alice', { forceDependencyGate: true })
    expect(
      listIntentLogs(r.id).some((l) => l.operationType === 'dependency_gate_force_release'),
    ).toBe(false)
  })
})
