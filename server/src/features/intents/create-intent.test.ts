/**
 * `create_intent` — 新增意图弹窗背后的那一次请求:登记意图、落基准分支快照,并在
 * 同一个 handler 里继续为它起意图会话。
 *
 * 这里钉四件事:
 *  1. 三种基准选择各自落库成什么 —— 选交付落该交付的分支、选分支落该分支、不选落
 *     工作区主分支。「默认」在协议上是显式的分支选择(弹窗预填主分支),因此它和另
 *     外两种一样可以被断言,而不是一条看不见的服务端兜底;
 *  2. 拒绝路径一律**不留半条意图** —— 校验都发生在 INSERT 之前,所以「拒绝后台账
 *     干净」是结构决定的,不靠事后清理;
 *  3. 会话只起一条,且它的第一句话就是共享 builder 对这条新记录的输出 —— 新入口不
 *     允许另写一套 prompt 模板;正文由 builder 的「当前内容」前缀承载,用户输入块
 *     只是指回它的分析指示,因此原文在首轮 prompt 里只出现一次;
 *  4. 启动失败时会话资源被回收,但意图连同内容和基准**留下** —— 用户刚敲的内容不能
 *     因为会话没起来就被丢掉;
 *  5. **选交付即关联交付** —— 选交付落的不只是一个分支名,还有 `intent_deliveries`
 *     那条边,因此建 PR 目标、依赖闸门与会话交付上下文从第一刻起就在交付语境里,
 *     用户不必事后再补一次「关联交付」。选分支/不选则一条边都不产生。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { removeRuntime } from '../../runs.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import {
  createDelivery,
  listAssociatedIntents,
  resetStoreForTests as resetDeliveryStoreForTests,
  setDeliveryBranch,
} from '../deliveries/store.js'
import {
  listOwnedForWorkspace,
  resetStoreForTests as resetSessionMetadataStoreForTests,
} from '../sessions/session-metadata-store.js'
import {
  CREATE_INTENT_REFINE_INSTRUCTION,
  buildIntentSessionFirstPrompt,
  createIntent,
  deleteIntent,
} from './index.js'
import { getIntent, listIntentLogs, listIntents, resetStoreForTests } from './store.js'
import { resetForTests as resetIntentLink, takePendingIntentLink } from './intent-link.js'
import { initTestGitRepo } from '../../../test/git-repo.js'

let dir: string
let other: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-create-intent-'))
  other = mkdtempSync(join(tmpdir(), 'c3-create-intent-other-'))
  // 起会话的用例要过 worktree 准入,准入要一个有提交的真实仓库。
  initTestGitRepo(dir)
  process.env.CLAUDE_CONFIG_DIR = dir
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetDeliveryStoreForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetIntentLink()
  addWorkspace(dir, 1)
  addWorkspace(other, 2)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetDeliveryStoreForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetIntentLink()
  delete process.env.CLAUDE_CONFIG_DIR
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
  vi.clearAllMocks()
})

function harness(launchRun = vi.fn().mockResolvedValue(undefined)) {
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
  const broadcastIntents = vi.fn()
  const broadcastDeliveries = vi.fn()
  const ctx = { launchRun, broadcastIntents, broadcastDeliveries } as unknown as KernelContext
  return { sent, conn, ctx, launchRun, broadcastIntents, broadcastDeliveries }
}

/** 一条本工作区的交付;给了 `branch` 就同时标记分支就绪。 */
function seedDelivery(title: string, branch?: string, workspacePath = proj) {
  const { delivery } = createDelivery({
    workspacePath,
    title,
    description: '',
    startDate: null,
    endDate: null,
    baseBranch: 'main',
  })
  return branch ? setDeliveryBranch(delivery.id, branch, true)! : delivery
}

function selectedSessionId(sent: ServerToClient[]): string {
  const m = sent.find((x) => x.type === 'session_selected')
  return m && m.type === 'session_selected' ? m.sessionId : ''
}

describe('create_intent — 基准分支落库', () => {
  it('选交付 → 落该交付的分支(由服务端从交付记录读,不信客户端)', async () => {
    const delivery = seedDelivery('D1', 'delivery/v1')
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'delivery', deliveryId: delivery.id },
    })

    const intents = listIntents(proj)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({
      title: 'new intent',
      content: 'CONTENT_ABC',
      status: 'draft',
      priority: 'P2',
      baseBranch: 'delivery/v1',
      baseBranchFallback: false,
    })

    removeRuntime(selectedSessionId(h.sent))
  })

  it('选分支 → 落该分支', async () => {
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'branch', branch: 'feature/x' },
    })

    expect(listIntents(proj)[0]).toMatchObject({
      content: 'CONTENT_ABC',
      baseBranch: 'feature/x',
      baseBranchFallback: false,
      // 选分支只是选了一个基线,不是选了一条交付——不产生任何关联边。
      linkedDeliveries: [],
    })

    removeRuntime(selectedSessionId(h.sent))
  })

  it('默认 → 弹窗预填的工作区主分支,作为显式分支选择落库', async () => {
    saveWorkspaceSetting(proj, { defaultMainBranch: 'develop' })
    const h = harness()

    // 弹窗预填 `defaultMainBranch` 后走的就是 branch 支——「默认」因此是可断言的
    // 显式值,而不是服务端的隐式兜底。
    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'branch', branch: 'develop' },
    })

    expect(listIntents(proj)[0]).toMatchObject({
      content: 'CONTENT_ABC',
      baseBranch: 'develop',
      baseBranchFallback: false,
    })

    removeRuntime(selectedSessionId(h.sent))
  })

  it('完全不带 base(旧客户端)→ 仍落工作区主分支,行为不变', async () => {
    saveWorkspaceSetting(proj, { defaultMainBranch: 'develop' })
    const h = harness()

    await createIntent(h.ctx, h.conn, { type: 'create_intent', workspaceId })

    expect(listIntents(proj)[0]).toMatchObject({
      title: 'new intent',
      content: '',
      baseBranch: 'develop',
      linkedDeliveries: [],
    })
    // 没有内容就没有会话——「+」的空白登记语义原样保留。
    expect(h.launchRun).not.toHaveBeenCalled()
    expect(h.sent.some((m) => m.type === 'session_selected')).toBe(false)
  })
})

/**
 * 「选交付」是一次对交付的选择,不是对分支名的选择:关联边和基准快照必须在同一次创建
 * 里一起落定,否则用户明明选了交付,建 PR 目标、依赖闸门与会话交付上下文却仍按「无
 * 关联交付」解析,还得再去补一次手动关联。
 */
describe('create_intent — 选交付即自动关联交付', () => {
  it('落库意图的同时写入关联边,回执与读模型都带上该交付', async () => {
    const delivery = seedDelivery('D1', 'delivery/v1')
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'delivery', deliveryId: delivery.id },
    })

    const created = getIntent(listIntents(proj)[0].id)!
    expect(created).toMatchObject({
      baseBranch: 'delivery/v1',
      baseBranchFallback: false,
      linkedDeliveries: [{ id: delivery.id, title: 'D1' }],
    })
    // 回执是客户端落点用的那份快照——它必须已经含关联,而不是等下一次广播才补上。
    expect(h.sent.find((m) => m.type === 'create_intent_result')).toMatchObject({
      intent: { id: created.id, linkedDeliveries: [{ id: delivery.id }] },
    })
    // 交付详情的「关联意图」读的是同一条边,所以这次写入也得推到交付侧。
    expect(listAssociatedIntents(delivery.id)).toMatchObject([{ id: created.id }])
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(proj)

    removeRuntime(selectedSessionId(h.sent))
  })

  it('内容为空的空白登记同样关联 —— 不留「选了交付却没有关联」的角落', async () => {
    const delivery = seedDelivery('D1', 'delivery/v1')
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      base: { kind: 'delivery', deliveryId: delivery.id },
    })

    expect(listIntents(proj)[0]).toMatchObject({
      content: '',
      baseBranch: 'delivery/v1',
      linkedDeliveries: [{ id: delivery.id }],
    })
    // 空白登记的语义不变:关联了也不起会话。
    expect(h.launchRun).not.toHaveBeenCalled()
  })
})

describe('create_intent — 基准拒绝路径(一条意图都不留)', () => {
  it.each([
    ['交付不存在', () => ({ kind: 'delivery', deliveryId: 'nope' }) as const],
    [
      '交付属于别的工作区',
      () => ({ kind: 'delivery', deliveryId: seedDelivery('X', 'b', other).id }) as const,
    ],
  ])('%s → 拒绝', async (_label, makeBase) => {
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: makeBase(),
    })

    expect(h.sent).toMatchObject([
      { type: 'error', error: { code: 'intent.deliveryContextUnknown' } },
    ])
    expect(listIntents(proj)).toEqual([])
    expect(h.launchRun).not.toHaveBeenCalled()
  })

  it.each([
    ['分支未初始化(branchName 为空)', undefined, false],
    ['分支名有值但未就绪', 'delivery/v1', false],
  ])('%s → 拒绝,不回退到主分支', async (_label, branch, ready) => {
    const delivery = seedDelivery('D1')
    if (branch) setDeliveryBranch(delivery.id, branch, ready)
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'delivery', deliveryId: delivery.id },
    })

    expect(h.sent).toMatchObject([
      { type: 'error', error: { code: 'delivery.guard.branchNotReady' } },
    ])
    expect(listIntents(proj)).toEqual([])
    // 拒绝发生在 INSERT 之前,所以既没有意图,也没有那条本会跟着意图一起写的关联边。
    expect(listAssociatedIntents(delivery.id)).toEqual([])
  })

  it('分支名为空白 → 拒绝,而不是落一个空基准', async () => {
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'branch', branch: '   ' },
    })

    expect(h.sent).toMatchObject([{ type: 'error', error: { code: 'intent.baseBranchRequired' } }])
    expect(listIntents(proj)).toEqual([])
  })

  it('未知工作区 → 拒绝', async () => {
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId: 'nope',
      content: 'CONTENT_ABC',
      base: { kind: 'branch', branch: 'main' },
    })

    expect(h.sent).toMatchObject([{ type: 'error', error: { code: 'workspace.unknown' } }])
    expect(listIntents(proj)).toEqual([])
  })
})

describe('create_intent — 连续启动意图会话', () => {
  it('只起一条 owner 会话,回填 intent_session_id,并回一次精确的创建结果', async () => {
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'branch', branch: 'main' },
    })

    const intentId = listIntents(proj)[0].id
    const sid = selectedSessionId(h.sent)
    expect(sid).toBeTruthy()
    expect(getIntent(intentId)?.intentSessionId).toBe(sid)
    expect(takePendingIntentLink(sid)).toBe(intentId)
    // 会话以这条意图为 owner——它不是一条游离的沟通会话。
    expect(listOwnedForWorkspace(proj)).toMatchObject([
      { sessionKind: 'intent', ownerKind: 'intent', ownerId: intentId, vendorSessionId: sid },
    ])
    // 客户端按返回的精确 id 落点,不按列表位置或标题推断。
    expect(h.sent.find((m) => m.type === 'create_intent_result')).toMatchObject({
      workspaceId,
      intent: { id: intentId },
    })
    expect(h.launchRun).toHaveBeenCalledTimes(1)

    removeRuntime(sid)
  })

  it('第一句话就是共享 builder 对这条新记录的输出,用户输入块是分析指示', async () => {
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'branch', branch: 'main' },
    })

    const created = getIntent(listIntents(proj)[0].id)!
    const prompt = h.launchRun.mock.calls[0][1]
    expect(prompt).toBe(buildIntentSessionFirstPrompt(created, CREATE_INTENT_REFINE_INSTRUCTION))
    // 刚敲的内容已经是这条意图的正文,builder 的「当前内容」前缀就是它的唯一副本——
    // 用户输入块再贴一遍只会让长内容把首轮上下文占两份。
    expect(prompt.split('CONTENT_ABC')).toHaveLength(2)

    removeRuntime(selectedSessionId(h.sent))
  })

  it('内容前后空白被裁掉后再落库并进 prompt', async () => {
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: '  CONTENT_ABC  ',
      base: { kind: 'branch', branch: 'main' },
    })

    const created = getIntent(listIntents(proj)[0].id)!
    expect(created.content).toBe('CONTENT_ABC')
    expect(h.launchRun.mock.calls[0][1]).toContain('CONTENT_ABC')

    removeRuntime(selectedSessionId(h.sent))
  })

  it('只有空白内容 → 只登记意图,不起会话', async () => {
    const h = harness()

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: '   ',
      base: { kind: 'branch', branch: 'feature/x' },
    })

    expect(listIntents(proj)[0]).toMatchObject({ content: '', baseBranch: 'feature/x' })
    expect(h.launchRun).not.toHaveBeenCalled()
  })

  // 基准取仓库里真实存在的分支:这条用例钉的是 launchRun 抛错之后的回收,所以启动
  // 必须先过 worktree 准入,否则拿到的是准入拒绝、根本走不到回收。
  it('启动失败 → 回收会话资源,但意图连同内容和基准留下', async () => {
    const h = harness(vi.fn().mockRejectedValue(new Error('LAUNCH_BOOM')))

    await createIntent(h.ctx, h.conn, {
      type: 'create_intent',
      workspaceId,
      content: 'CONTENT_ABC',
      base: { kind: 'branch', branch: 'main' },
    })

    expect(h.sent.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'intent.startSessionFailed' },
    })
    const intents = listIntents(proj)
    expect(intents).toHaveLength(1)
    // 意图是已经落库的事实:内容和基准都不因为会话没起来而回滚。
    expect(intents[0]).toMatchObject({ content: 'CONTENT_ABC', baseBranch: 'main' })
    expect(getIntent(intents[0].id)?.intentSessionId).toBeNull()
    expect(takePendingIntentLink(selectedSessionId(h.sent))).toBeUndefined()
  })
})

/**
 * 删除侧的两条守卫,和创建是同一条生命周期的两端:刚登记的意图必须还能被物理删掉
 * (否则一次误建就永久留在台账上),而删除必须认工作区归属。放在这里是因为它们钉的
 * 正是「create_intent 刚产出的那条记录」的可删性。
 */
describe('create_intent 产出的意图 — 删除守卫', () => {
  it('仍是无下游资产的 draft 时,允许物理删除', async () => {
    const h = harness()
    await createIntent(h.ctx, h.conn, { type: 'create_intent', workspaceId })
    const id = listIntents(proj)[0].id

    await deleteIntent(h.ctx, h.conn, { type: 'delete_intent', workspaceId, intentId: id })

    expect(getIntent(id)).toBeNull()
    expect(listIntentLogs(id)).toEqual([])
  })

  it('删除时指名另一个工作区 → 拒绝,意图留在原处', async () => {
    const h = harness()
    await createIntent(h.ctx, h.conn, { type: 'create_intent', workspaceId })
    const id = listIntents(proj)[0].id

    await deleteIntent(h.ctx, h.conn, {
      type: 'delete_intent',
      workspaceId: pathToId(other)!,
      intentId: id,
    })

    expect(getIntent(id)).not.toBeNull()
    expect(h.sent.at(-1)).toMatchObject({ type: 'error', error: { code: 'intent.notFound' } })
  })
})
