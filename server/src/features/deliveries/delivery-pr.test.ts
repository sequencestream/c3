/**
 * Feature-level tests for the delivery PR (「交付分支 → 主线」) over a real temp
 * c3.db + a real throwaway git repo with a bare origin.
 *
 * Only the FORGE round trips are mocked (`findOpenForgePr` / `createForgePr` /
 * `getForgeDeliveryPrFacts`) — the refs, the SHA pair and the ahead-count all run
 * against real git, because those are the parts whose logic is easy to get subtly
 * wrong. `deliveryMergeTrial` is mocked in the conflict cases so the conflicting
 * file list is a controlled input rather than a second thing under test.
 *
 * What the assertions are about, beyond mechanics:
 *  - creating ALWAYS asks the forge first, so a lost response or a lost ledger row
 *    converges on the SAME PR instead of a duplicate;
 *  - the three failure classes stay separated: a conflict rolls the delivery back,
 *    a red CI / missing approval does NOT (the code is fine — rolling back would
 *    make the user redo a verification for nothing), and an unreadable forge
 *    changes nothing at all;
 *  - `delivered` lands as one unit and its consequences (no intent rewrite, queue
 *    recompute, event, log) all follow from it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { GenericEvent } from '@ccc/shared'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { saveWorkspaceSetting } from '../../kernel/config/index.js'
import { addWorkspace, pathToId, resetStateCacheForTests } from '../../state.js'
import {
  createForgePr,
  deliveryMergeTrial,
  findMergedForgePr,
  findOpenForgePr,
  getForgeDeliveryPrFacts,
} from '../../git.js'
import { markQueueDirty } from '../intents/workflow.js'
import {
  createDeliveryHandler,
  createDeliveryPrHandler,
  getDeliveryDetailHandler,
  initDeliveryBranchHandler,
  listDeliveriesHandler,
  syncDeliveryPrHandler,
  transitionDeliveryHandler,
} from './index.js'
import {
  getDelivery,
  getLatestDeliveryPr,
  listDeliveries,
  listDeliveryLogs,
  resetStoreForTests,
} from './store.js'
import {
  insertIntents,
  listIntentPrs,
  upsertIntentPr,
  getIntent,
  resetStoreForTests as resetIntentStoreForTests,
} from '../intents/store.js'
import { insertIntentDelivery, listAssociatedIntents } from './store.js'

vi.mock('../../git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../git.js')>()),
  findOpenForgePr: vi.fn(),
  findMergedForgePr: vi.fn(),
  createForgePr: vi.fn(),
  getForgeDeliveryPrFacts: vi.fn(),
  deliveryMergeTrial: vi.fn(),
}))

vi.mock('../intents/workflow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../intents/workflow.js')>()),
  markQueueDirty: vi.fn(() => undefined),
}))

const findOpenForgePrMock = vi.mocked(findOpenForgePr)
const findMergedForgePrMock = vi.mocked(findMergedForgePr)
const createForgePrMock = vi.mocked(createForgePr)
const forgeFactsMock = vi.mocked(getForgeDeliveryPrFacts)
const mergeTrialMock = vi.mocked(deliveryMergeTrial)
const markQueueDirtyMock = vi.mocked(markQueueDirty)

const BRANCH = 'delivery/abc-sprint-3'

let dir: string
let bare: string
let workspaceId: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).toString().trim()
}

/** `dir` as a git repo rooted at `main` with a bare origin. */
function initWorkspaceRepo(): void {
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.dev')
  git('config', 'user.name', 'tester')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'README.md'), 'init\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  bare = join(dirname(dir), `${basename(dir)}-remote.git`)
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare], { cwd: dirname(dir) })
  git('remote', 'add', 'origin', bare)
  git('push', '-q', '-u', 'origin', 'HEAD')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-delivery-pr-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3-home')
  process.env.CLAUDE_CONFIG_DIR = dir
  resetDbForTests()
  resetStoreForTests()
  resetIntentStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  saveWorkspaceSetting(dir, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
  vi.clearAllMocks()
  // Every path that reaches the forge for a MERGED PR treats 「查不到」 as a
  // non-event, so that is the default here too; the cases that care set their own.
  findMergedForgePrMock.mockResolvedValue({ ok: true, pr: null })
  initWorkspaceRepo()
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
})

interface Harness {
  sent: ServerToClient[]
  conn: Conn
  ctx: KernelContext
  broadcastDeliveries: ReturnType<typeof vi.fn>
  broadcastIntents: ReturnType<typeof vi.fn>
  published: { workspacePath: string; sessionId: string; event: GenericEvent }[]
}

function harness(subject: string | null = null): Harness {
  const sent: ServerToClient[] = []
  const published: Harness['published'] = []
  const conn = { send: (m: ServerToClient) => sent.push(m), subject } as unknown as Conn
  const broadcastDeliveries = vi.fn()
  const broadcastIntents = vi.fn()
  const ctx = {
    broadcastDeliveries,
    broadcastIntents,
    // Mirrors the composition root: the registry's default normalizer accepts any
    // `<category>:<action>` type after structural redaction.
    normalizeEvent: (core: GenericEvent) => ({ ok: true as const, event: core }),
    eventBus: {
      publish: (topic: string, payload: Harness['published'][number]) => {
        if (topic === 'event') published.push(payload)
      },
    },
  } as unknown as KernelContext
  return { sent, conn, ctx, broadcastDeliveries, broadcastIntents, published }
}

function errorCodes(sent: ServerToClient[]): string[] {
  return sent
    .filter((f): f is Extract<ServerToClient, { type: 'error' }> => f.type === 'error')
    .map((f) => f.error.code)
}

function detailOf(sent: ServerToClient[]): Extract<ServerToClient, { type: 'delivery_detail' }> {
  const frame = sent.find((f) => f.type === 'delivery_detail')
  if (!frame || frame.type !== 'delivery_detail') throw new Error('no delivery_detail frame')
  return frame
}

/** Create a delivery, initialize its branch, and drive it to `status`. */
async function seedDelivery(
  status: 'planned' | 'integrating' | 'verifying' | 'verified',
  { withCommit = true }: { withCommit?: boolean } = {},
): Promise<string> {
  const h = harness()
  createDeliveryHandler(h.ctx, h.conn, {
    type: 'create_delivery',
    workspaceId,
    title: 'Sprint 3',
    description: 'batch',
  })
  const id = listDeliveries(dir)[0].id
  await initDeliveryBranchHandler(h.ctx, h.conn, {
    type: 'init_delivery_branch',
    workspaceId,
    deliveryId: id,
    branchName: BRANCH,
    mode: 'create',
  })
  if (withCommit) {
    // A real commit on the delivery branch, so `ahead > 0` is a fact and not a stub.
    git('checkout', '-q', BRANCH)
    writeFileSync(join(dir, 'feature.txt'), 'work\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'feature')
    git('push', '-q', 'origin', BRANCH)
    git('checkout', '-q', 'main')
  }
  if (status === 'planned') return id

  // The integration guard needs one associated intent whose PR toward this
  // delivery is merged; the state machine is the gate, so it is satisfied for real.
  const [intent] = insertIntents(dir, [
    { title: 'Intent A', shortEnTitle: 'intent-a', content: '', priority: 'P2', module: '' },
  ])
  insertIntentDelivery(id, intent.id, BRANCH)
  upsertIntentPr({
    intentId: intent.id,
    deliveryId: id,
    forge: 'github',
    repo: 'o/r',
    number: '1',
    status: 'merged',
  })
  const step = (to: 'integrating' | 'verifying' | 'verified'): void => {
    void transitionDeliveryHandler(h.ctx, h.conn, {
      type: 'transition_delivery',
      workspaceId,
      deliveryId: id,
      to,
      confirmVerified: true,
    })
  }
  step('integrating')
  if (status === 'integrating') return id
  step('verifying')
  if (status === 'verifying') return id
  step('verified')
  return id
}

const NO_OPEN_PR = { ok: true as const, pr: null }

describe('create_delivery_pr — gates', () => {
  it('refuses a delivery that is not verified', async () => {
    const id = await seedDelivery('integrating')
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    expect(errorCodes(h.sent)).toEqual(['delivery.deliveryPrForbidden'])
    expect(findOpenForgePrMock).not.toHaveBeenCalled()
  })

  it('refuses in current-branch mode (no delivery branch exists there)', async () => {
    const id = await seedDelivery('verified')
    saveWorkspaceSetting(dir, { gitBranchMode: 'current-branch', defaultMainBranch: 'main' })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    expect(errorCodes(h.sent)).toEqual(['delivery.deliveryPrModeUnsupported'])
  })

  it('checks the status gate before the branch gate (fixed order)', async () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, {
      type: 'create_delivery',
      workspaceId,
      title: 'No branch',
    })
    const id = listDeliveries(dir)[0].id
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    // The branch gate is reached only after the status gate, so this delivery
    // (still `planned`) reports the status gap — the order is the contract.
    expect(errorCodes(h.sent)).toEqual(['delivery.deliveryPrForbidden'])
  })

  it('refuses when the delivery branch never carried integrated output', async () => {
    const id = await seedDelivery('verified', { withCommit: false })
    // A second association whose PR is NOT merged: the ledger no longer proves the
    // branch carries everything it should, so 「无差异」 stays 「无事可提」.
    const [extra] = insertIntents(dir, [
      { title: 'Intent B', shortEnTitle: 'intent-b', content: '', priority: 'P2', module: '' },
    ])
    insertIntentDelivery(id, extra.id, BRANCH)
    upsertIntentPr({
      intentId: extra.id,
      deliveryId: id,
      forge: 'github',
      repo: 'o/r',
      number: '2',
      status: 'reviewing',
    })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    expect(errorCodes(h.sent)).toEqual(['delivery.deliveryPrNoDiff'])
    expect(createForgePrMock).not.toHaveBeenCalled()
  })
})

describe('create_delivery_pr — a branch already on mainline settles as delivered', () => {
  it('settles delivered instead of refusing, and adopts the merged PR the forge holds', async () => {
    // The delivery branch carries the integrated output but holds nothing mainline
    // does not — somebody merged it outside c3. There is no PR left to open, and
    // `delivered` is a system-only edge, so refusing here would strand the delivery.
    const id = await seedDelivery('verified', { withCommit: false })
    findMergedForgePrMock.mockResolvedValue({
      ok: true,
      pr: { number: '88', url: 'https://github.com/o/r/pull/88' },
    })
    const h = harness('alice')
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })

    expect(errorCodes(h.sent)).toEqual([])
    expect(createForgePrMock).not.toHaveBeenCalled()
    expect(getDelivery(id)!.status).toBe('delivered')
    expect(getLatestDeliveryPr(id)).toMatchObject({ number: '88', status: 'merged' })
    const frame = detailOf(h.sent)
    expect(frame.delivery.status).toBe('delivered')
    // The user asked for a PR and got a terminal status — the page has to say why.
    expect(frame.notice).toBe('delivery.autoDelivered')
    expect(listDeliveryLogs(id).find((l) => l.operationType === 'delivered')!.summary).toContain(
      '#88',
    )
    expect(h.published.map((p) => p.event.type)).toEqual([
      'delivery:status_changed',
      'delivery:delivered',
    ])
    expect(markQueueDirtyMock).toHaveBeenCalledWith(dir)
  })

  it('settles delivered even when the forge holds no merged PR to name', async () => {
    const id = await seedDelivery('verified', { withCommit: false })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })

    expect(getDelivery(id)!.status).toBe('delivered')
    // Nothing is invented: no PR row, and the event carries no `prNumber`.
    expect(getLatestDeliveryPr(id)).toBeNull()
    const metadata = h.published.find((p) => p.event.type === 'delivery:delivered')!.event.metadata
    expect(metadata).toMatchObject({ deliveryId: id, branch: BRANCH })
    expect(metadata?.prNumber).toBeUndefined()
  })

  it('settles delivered even when the merged-PR lookup itself fails', async () => {
    // Git already proved the code is in mainline; an unreadable forge only costs
    // the PR number, never the terminal status.
    const id = await seedDelivery('verified', { withCommit: false })
    findMergedForgePrMock.mockResolvedValue({ ok: false, error: 'offline' })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    expect(errorCodes(h.sent)).toEqual([])
    expect(getDelivery(id)!.status).toBe('delivered')
  })
})

describe('create_delivery_pr — forge-first idempotency', () => {
  it('creates the PR with head = delivery branch, base = mainline, and records the SHA pair', async () => {
    const id = await seedDelivery('verified')
    findOpenForgePrMock.mockResolvedValue(NO_OPEN_PR)
    createForgePrMock.mockResolvedValue({
      ok: true,
      prId: '77',
      prUrl: 'https://github.com/o/r/pull/77',
    })
    const h = harness('alice')
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })

    expect(createForgePrMock).toHaveBeenCalledWith(
      dir,
      expect.stringContaining('Sprint 3'),
      expect.any(String),
      BRANCH,
      'main',
      undefined,
    )
    const row = getLatestDeliveryPr(id)!
    expect(row).toMatchObject({
      number: '77',
      url: 'https://github.com/o/r/pull/77',
      headBranch: BRANCH,
      baseBranch: 'main',
      status: 'reviewing',
      forge: 'github',
      repo: 'o/r',
      blockedReason: null,
    })
    expect(row.baseSha).toBe(git('rev-parse', 'origin/main'))
    expect(row.headSha).toBe(git('rev-parse', `origin/${BRANCH}`))
    expect(detailOf(h.sent).deliveryPr).toMatchObject({ number: '77' })
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
  })

  it('adopts the forge PR on retry instead of creating a second one', async () => {
    const id = await seedDelivery('verified')
    findOpenForgePrMock.mockResolvedValue(NO_OPEN_PR)
    createForgePrMock.mockResolvedValue({
      ok: true,
      prId: '77',
      prUrl: 'https://github.com/o/r/pull/77',
    })
    const msg = { type: 'create_delivery_pr' as const, workspaceId, deliveryId: id }
    await createDeliveryPrHandler(harness().ctx, harness().conn, msg)

    // Second attempt: the forge now reports the PR the first attempt made.
    findOpenForgePrMock.mockResolvedValue({
      ok: true,
      pr: { number: '77', url: 'https://github.com/o/r/pull/77' },
    })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, msg)

    expect(createForgePrMock).toHaveBeenCalledTimes(1)
    expect(getLatestDeliveryPr(id)).toMatchObject({ number: '77' })
    expect(errorCodes(h.sent)).toEqual([])
  })

  it('adopts a forge PR the ledger never recorded (a lost create response)', async () => {
    const id = await seedDelivery('verified')
    findOpenForgePrMock.mockResolvedValue({
      ok: true,
      pr: { number: '88', url: 'https://github.com/o/r/pull/88' },
    })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    expect(createForgePrMock).not.toHaveBeenCalled()
    expect(getLatestDeliveryPr(id)).toMatchObject({ number: '88', status: 'reviewing' })
  })

  it('aborts without creating when the forge lookup itself fails', async () => {
    const id = await seedDelivery('verified')
    findOpenForgePrMock.mockResolvedValue({ ok: false, error: 'gh CLI 未安装', unavailable: true })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    // "Cannot answer" is never treated as "none" — that is how duplicates are born.
    expect(createForgePrMock).not.toHaveBeenCalled()
    expect(errorCodes(h.sent)).toEqual(['delivery.deliveryPrCreateFailed'])
    expect(getLatestDeliveryPr(id)).toBeNull()
    expect(getDelivery(id)!.status).toBe('verified')
  })

  it('is available to a NON-admin workspace member (the forge is the real gate)', async () => {
    const id = await seedDelivery('verified')
    findOpenForgePrMock.mockResolvedValue(NO_OPEN_PR)
    createForgePrMock.mockResolvedValue({ ok: true, prId: '5' })
    // `subject: null` is an unauthenticated / non-admin connection.
    const h = harness(null)
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    expect(errorCodes(h.sent)).toEqual([])
    expect(getLatestDeliveryPr(id)).toMatchObject({ number: '5' })
  })
})

/** Create a delivery in `verified` that already holds an open delivery PR row. */
async function seedWithPr(): Promise<string> {
  const id = await seedDelivery('verified')
  findOpenForgePrMock.mockResolvedValue(NO_OPEN_PR)
  createForgePrMock.mockResolvedValue({
    ok: true,
    prId: '77',
    prUrl: 'https://github.com/o/r/pull/77',
  })
  const h = harness()
  await createDeliveryPrHandler(h.ctx, h.conn, {
    type: 'create_delivery_pr',
    workspaceId,
    deliveryId: id,
  })
  return id
}

const syncMsg = (deliveryId: string) => ({
  type: 'sync_delivery_pr' as const,
  workspaceId,
  deliveryId,
})

describe('delivery:* events on the PR paths', () => {
  it('create_delivery_pr publishes delivery:pr_created with the PR and the merge target', async () => {
    const id = await seedDelivery('verified')
    findOpenForgePrMock.mockResolvedValue(NO_OPEN_PR)
    createForgePrMock.mockResolvedValue({
      ok: true,
      prId: '77',
      prUrl: 'https://github.com/o/r/pull/77',
    })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })

    expect(h.published.map((p) => p.event.type)).toEqual(['delivery:pr_created'])
    expect(h.published[0].event.metadata).toMatchObject({
      deliveryId: id,
      title: 'Sprint 3',
      prNumber: '77',
      prUrl: 'https://github.com/o/r/pull/77',
      baseBranch: 'main',
    })
    expect(h.published[0].workspacePath).toBe(dir)
  })

  it('the forge-first adoption publishes it too — the fact is 「交付 PR 已就绪」', async () => {
    const id = await seedDelivery('verified')
    findOpenForgePrMock.mockResolvedValue({
      ok: true,
      pr: { number: '88', url: 'https://github.com/o/r/pull/88' },
    })
    const h = harness()
    await createDeliveryPrHandler(h.ctx, h.conn, {
      type: 'create_delivery_pr',
      workspaceId,
      deliveryId: id,
    })
    expect(createForgePrMock).not.toHaveBeenCalled()
    expect(h.published.map((p) => p.event.type)).toEqual(['delivery:pr_created'])
    expect(h.published[0].event.metadata).toMatchObject({ prNumber: '88' })
  })

  it('the conflict rollback publishes status_changed verified → verifying', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', conflict: true })
    mergeTrialMock.mockResolvedValue({ baseSha: 'b1', headSha: 'h2', conflictFiles: ['src/a.ts'] })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))

    expect(h.published.map((p) => p.event.type)).toEqual(['delivery:status_changed'])
    expect(h.published[0].event.metadata).toMatchObject({
      deliveryId: id,
      from: 'verified',
      to: 'verifying',
    })
  })

  it('a sync that moves nothing publishes nothing', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', ciFailed: true })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))
    expect(h.published).toEqual([])
  })

  it('a publish failure does not roll back the committed status write', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'merged' })
    const h = harness()
    // The normalizer refuses every event — the delivery still lands `delivered`,
    // the queue is still recomputed, and only a warning is logged.
    ;(h.ctx as unknown as { normalizeEvent: () => unknown }).normalizeEvent = () => ({
      ok: false,
      reason: 'test refusal',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))

    expect(getDelivery(id)!.status).toBe('delivered')
    expect(h.published).toEqual([])
    expect(markQueueDirtyMock).toHaveBeenCalledWith(dir)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('sync_delivery_pr — layered settlement', () => {
  it('refuses a delivery that never opened a delivery PR', async () => {
    const id = await seedDelivery('verified')
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))
    expect(errorCodes(h.sent)).toEqual(['delivery.deliveryPrNotFound'])
  })

  it('merge conflict → verified rolls back to verifying, with files and SHA pair', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', conflict: true })
    mergeTrialMock.mockResolvedValue({
      baseSha: 'base1111',
      headSha: 'head2222',
      conflictFiles: ['src/a.ts', 'src/b.ts'],
    })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))

    expect(getDelivery(id)!.status).toBe('verifying')
    expect(getLatestDeliveryPr(id)).toMatchObject({
      conflictFiles: ['src/a.ts', 'src/b.ts'],
      baseSha: 'base1111',
      headSha: 'head2222',
      status: 'reviewing',
      blockedReason: null,
    })
    expect(listDeliveryLogs(id).some((l) => l.operationType === 'merge_conflict')).toBe(true)
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
  })

  it('merge conflict whose local trial failed still rolls back, with an empty file list', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', conflict: true })
    mergeTrialMock.mockResolvedValue({ baseSha: null, headSha: null, conflictFiles: [] })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))
    // The forge's verdict is sufficient on its own; the file list is only the
    // explanation offered on top of it.
    expect(getDelivery(id)!.status).toBe('verifying')
    expect(getLatestDeliveryPr(id)!.conflictFiles).toEqual([])
  })

  it('failing CI → status stays verified, blockedReason recorded', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', ciFailed: true })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))
    // The code is fine — rolling back here would make the user redo a verification
    // that nothing invalidated.
    expect(getDelivery(id)!.status).toBe('verified')
    expect(getLatestDeliveryPr(id)).toMatchObject({
      blockedReason: 'ci_failed',
      status: 'reviewing',
    })
    expect(errorCodes(h.sent)).toEqual([])
  })

  it('missing approvals → status stays verified, blockedReason recorded', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', approvalMissing: true })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))
    expect(getDelivery(id)!.status).toBe('verified')
    expect(getLatestDeliveryPr(id)!.blockedReason).toBe('approval')
  })

  it('an unblocked open PR clears a previously recorded block', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', ciFailed: true })
    await syncDeliveryPrHandler(harness().ctx, harness().conn, syncMsg(id))
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing' })
    await syncDeliveryPrHandler(harness().ctx, harness().conn, syncMsg(id))
    expect(getLatestDeliveryPr(id)!.blockedReason).toBeNull()
    expect(getDelivery(id)!.status).toBe('verified')
  })

  it('a closed PR syncs the row and leaves the delivery alone', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'closed' })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))
    expect(getLatestDeliveryPr(id)!.status).toBe('closed')
    expect(getDelivery(id)!.status).toBe('verified')
  })

  it('a closed PR whose code reached mainline anyway settles the delivery as delivered', async () => {
    const id = await seedWithPr()
    // The PR was closed and the branch merged another way — mainline now contains
    // everything the delivery branch holds.
    git('checkout', '-q', 'main')
    git('merge', '-q', '--no-ff', '--no-edit', BRANCH)
    git('push', '-q', 'origin', 'main')
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'closed' })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))

    expect(getDelivery(id)!.status).toBe('delivered')
    // The PR really is closed: settling the delivery must not forge a merge on it.
    expect(getLatestDeliveryPr(id)!.status).toBe('closed')
    expect(detailOf(h.sent).notice).toBe('delivery.autoDelivered')
    const log = listDeliveryLogs(id).find((l) => l.operationType === 'delivered')!
    expect(log.summary).toContain(BRANCH)
    expect(h.published.map((p) => p.event.type)).toEqual([
      'delivery:status_changed',
      'delivery:delivered',
    ])
  })

  it('a forge lookup failure changes nothing and is retryable', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: false, error: 'offline' })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))
    expect(errorCodes(h.sent)).toEqual(['delivery.deliveryPrSyncFailed'])
    expect(getDelivery(id)!.status).toBe('verified')
    expect(getLatestDeliveryPr(id)).toMatchObject({ status: 'reviewing', blockedReason: null })
  })
})

describe('sync_delivery_pr — delivered atomic write and its chained actions', () => {
  it('merged → delivered with status, log and PR row in one settled unit', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({
      ok: true,
      status: 'merged',
      prUrl: 'https://github.com/o/r/pull/77',
    })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))

    expect(getDelivery(id)!.status).toBe('delivered')
    expect(getLatestDeliveryPr(id)).toMatchObject({ status: 'merged', blockedReason: null })
    const log = listDeliveryLogs(id).find((l) => l.operationType === 'delivered')
    expect(log).toMatchObject({ actor: 'system' })
    expect(log!.summary).toContain('#77')
    expect(detailOf(h.sent).delivery.status).toBe('delivered')
  })

  it('publishes the status_changed trail AND delivery:delivered, and marks the queue dirty', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'merged' })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))

    // Terminal double-publish: a `delivery:*` subscriber sees the transition, a
    // subscriber to only the terminal fact still gets its own event.
    expect(h.published.map((p) => p.event.type)).toEqual([
      'delivery:status_changed',
      'delivery:delivered',
    ])
    expect(h.published[0].event).toMatchObject({
      type: 'delivery:status_changed',
      metadata: { deliveryId: id, title: 'Sprint 3', from: 'verified', to: 'delivered' },
    })
    expect(h.published[1].event).toMatchObject({
      type: 'delivery:delivered',
      metadata: { deliveryId: id, title: 'Sprint 3', baseBranch: 'main', branch: BRANCH },
    })
    // The cross-delivery dependency gate reads `delivered`; without the recompute
    // every intent blocked on this delivery would stay blocked forever.
    expect(markQueueDirtyMock).toHaveBeenCalledWith(dir)
    expect(h.broadcastIntents).toHaveBeenCalledWith(dir)
  })

  it('does NOT rewrite the associated intents', async () => {
    const id = await seedWithPr()
    const intentId = listAssociatedIntents(id)[0].id
    const before = getIntent(intentId)!
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'merged' })
    await syncDeliveryPrHandler(harness().ctx, harness().conn, syncMsg(id))
    // The intents reached `done` when their PRs merged into the delivery branch;
    // a second writer here would break status having a single driver.
    expect(getIntent(intentId)!.status).toBe(before.status)
    expect(listIntentPrs(intentId)[0].status).toBe('merged')
  })

  it('a repeat sync of an already-delivered delivery is a no-op, not a second write', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'merged' })
    await syncDeliveryPrHandler(harness().ctx, harness().conn, syncMsg(id))
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))

    expect(getDelivery(id)!.status).toBe('delivered')
    expect(listDeliveryLogs(id).filter((l) => l.operationType === 'delivered')).toHaveLength(1)
    expect(h.published).toHaveLength(0)
    expect(errorCodes(h.sent)).toEqual([])
  })

  it('refuses the delivered write when the state machine says no', async () => {
    // A conflict rolled the delivery back to `verifying`; someone then merged the
    // PR on the forge anyway. `verifying` has no `delivered` edge, and the sync
    // must not force one open — the state machine stays the single gate.
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', conflict: true })
    mergeTrialMock.mockResolvedValue({ baseSha: 'b', headSha: 'h', conflictFiles: ['x.ts'] })
    await syncDeliveryPrHandler(harness().ctx, harness().conn, syncMsg(id))
    expect(getDelivery(id)!.status).toBe('verifying')

    forgeFactsMock.mockResolvedValue({ ok: true, status: 'merged' })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))

    const failed = h.sent.find((f) => f.type === 'delivery_transition_failed')
    expect(failed).toMatchObject({ code: 'delivery.invalidStatusTransition', to: 'delivered' })
    expect(getDelivery(id)!.status).toBe('verifying')
    expect(listDeliveryLogs(id).some((l) => l.operationType === 'delivered')).toBe(false)
    expect(h.published).toHaveLength(0)
  })
})

describe('deliveryBranchAhead — fresh on the get/create reads only', () => {
  async function detail(id: string): Promise<Extract<ServerToClient, { type: 'delivery_detail' }>> {
    const h = harness()
    await getDeliveryDetailHandler(h.ctx, h.conn, {
      type: 'get_delivery_detail',
      deliveryId: id,
    })
    return detailOf(h.sent)
  }

  it('reads the delivery branch ahead of mainline on get_delivery_detail (> 0 with commits)', async () => {
    const id = await seedDelivery('verified')
    const frame = await detail(id)
    // The seeded delivery branch carries one commit mainline does not.
    expect(frame.deliveryBranchAhead).toBe(1)
    expect(frame.mainlineAhead).toBe(0)
  })

  it('reports 0 when the delivery branch holds nothing mainline lacks', async () => {
    const id = await seedDelivery('verified', { withCommit: false })
    const frame = await detail(id)
    expect(frame.deliveryBranchAhead).toBe(0)
    expect(frame.mainlineAhead).toBe(0)
  })

  it('reports null for a delivery with no branch yet', async () => {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, {
      type: 'create_delivery',
      workspaceId,
      title: 'No branch',
      description: '',
    })
    const id = listDeliveries(dir)[0].id
    const frame = await detail(id)
    expect(frame.deliveryBranchAhead).toBeNull()
    expect(frame.mainlineAhead).toBeNull()
  })

  it('leaves deliveryBranchAhead null on the sync_delivery_pr reply (not a fresh-read site)', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'closed' })
    const h = harness()
    await syncDeliveryPrHandler(h.ctx, h.conn, syncMsg(id))
    const frame = detailOf(h.sent)
    expect(frame.deliveryBranchAhead).toBeNull()
    expect(frame.mainlineAhead).toBeNull()
  })
})

describe('badge — delivery-PR attention', () => {
  const needsAction = (sent: ServerToClient[]): number => {
    const frame = sent.find((f) => f.type === 'deliveries')
    if (!frame || frame.type !== 'deliveries') throw new Error('no deliveries frame')
    return frame.needsActionCount
  }

  const list = (): ServerToClient[] => {
    const h = harness()
    listDeliveriesHandler(h.ctx, h.conn, { type: 'list_deliveries', workspaceId })
    return h.sent
  }

  it('counts a verified delivery whose PR is still to be opened', async () => {
    await seedDelivery('verified')
    expect(needsAction(list())).toBe(1)
  })

  it('does not count a verified delivery whose PR is open and unblocked', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing' })
    await syncDeliveryPrHandler(harness().ctx, harness().conn, syncMsg(id))
    // Waiting for someone else to press merge is not something the user can act on.
    expect(needsAction(list())).toBe(0)
  })

  it('counts a verified delivery whose PR is 「合并受阻」', async () => {
    const id = await seedWithPr()
    forgeFactsMock.mockResolvedValue({ ok: true, status: 'reviewing', ciFailed: true })
    await syncDeliveryPrHandler(harness().ctx, harness().conn, syncMsg(id))
    expect(needsAction(list())).toBe(1)
  })

  it('does not count under current-branch mode (the merge section is hidden there)', async () => {
    await seedDelivery('verified')
    saveWorkspaceSetting(dir, { gitBranchMode: 'current-branch', defaultMainBranch: 'main' })
    expect(needsAction(list())).toBe(0)
  })
})
