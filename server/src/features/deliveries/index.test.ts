/**
 * Feature-level tests for the delivery handlers over a real temp c3.db +
 * registered workspace: workspace-scoped create/list/detail/update, the
 * `base_branch` snapshot, the one-time `pr:merge` notice, cross-workspace
 * rejection, the status-machine write path (transition + cancel), the
 * server-computed badge count on the list reply, and the intent ↔ delivery
 * association (link, diff-bloat warning, and every unlink guard).
 *
 * Only the two FORGE calls are mocked (`getForgePrStatus` / `closeForgePr`) —
 * every git operation, including the diff-bloat detection, runs against real
 * throwaway repositories, because that is the part whose logic is easy to get
 * subtly wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { GenericEvent } from '@ccc/shared'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { saveWorkspaceSetting } from '../../kernel/config/index.js'
import { addWorkspace, pathToId, resetStateCacheForTests } from '../../state.js'
import { closeForgePr, getForgePrStatus } from '../../git.js'
import {
  cancelDeliveryHandler,
  cleanupDeliveryBranchHandler,
  createDeliveryHandler,
  getDeliveryDetailHandler,
  initDeliveryBranchHandler,
  linkIntentToDeliveryHandler,
  listDeliveriesHandler,
  transitionDeliveryHandler,
  unlinkIntentFromDeliveryHandler,
  updateDeliveryHandler,
} from './index.js'
import {
  getDelivery,
  isIntentLinked,
  listAssociatedIntents,
  listDeliveries,
  resetStoreForTests,
} from './store.js'
import {
  deleteIntentRecords,
  insertIntents,
  listIntentPrs,
  setLatestCommitHash,
  upsertIntentPr,
  resetStoreForTests as resetIntentStoreForTests,
} from '../intents/store.js'

// Only the forge round-trips are faked; every git helper stays real.
vi.mock('../../git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../git.js')>()),
  getForgePrStatus: vi.fn(),
  closeForgePr: vi.fn(),
}))

let dir: string
let workspaceId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-delivery-feature-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3-home')
  process.env.CLAUDE_CONFIG_DIR = dir
  resetDbForTests()
  resetStoreForTests()
  resetIntentStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
})

interface PublishedEvent {
  workspacePath: string
  sessionId: string
  event: GenericEvent
}

function harness() {
  const sent: ServerToClient[] = []
  const published: PublishedEvent[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m) } as unknown as Conn
  const broadcastDeliveries = vi.fn()
  const broadcastIntents = vi.fn()
  const ctx = {
    broadcastDeliveries,
    broadcastIntents,
    // Mirrors the composition root: the registry's default normalizer accepts any
    // `<category>:<action>` type after structural redaction.
    normalizeEvent: (core: GenericEvent) => ({ ok: true as const, event: core }),
    eventBus: {
      publish: (topic: string, payload: PublishedEvent) => {
        if (topic === 'event') published.push(payload)
      },
    },
  } as unknown as KernelContext
  return { sent, conn, ctx, broadcastDeliveries, broadcastIntents, published }
}

/** The `delivery:*` types published during one harness run, in publish order. */
function publishedTypes(published: PublishedEvent[]): string[] {
  return published.map((p) => p.event.type)
}

const createMsg = (overrides: Partial<{ title: string; description: string }> = {}) => ({
  type: 'create_delivery' as const,
  workspaceId,
  title: overrides.title ?? 'Sprint 3',
  description: overrides.description ?? '',
})

describe('create_delivery', () => {
  it('creates a planned delivery and snapshots the workspace defaultMainBranch', () => {
    saveWorkspaceSetting(dir, { gitBranchMode: 'worktree', defaultMainBranch: 'develop' })
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg())
    const created = listDeliveries(dir)[0]
    expect(created).toMatchObject({ title: 'Sprint 3', status: 'planned', baseBranch: 'develop' })
    expect(h.sent[0]).toMatchObject({
      type: 'create_delivery_result',
      workspaceId,
      delivery: { id: created.id },
      prMergeNotice: true,
    })
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
  })

  it('falls back to main when the workspace has no explicit defaultMainBranch', () => {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg())
    expect(listDeliveries(dir)[0].baseBranch).toBe('main')
  })

  it('rejects a blank title without writing', () => {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg({ title: '   ' }))
    expect(listDeliveries(dir)).toEqual([])
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.titleRequired' } })
  })

  it('rejects an unknown workspace', () => {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, {
      type: 'create_delivery',
      workspaceId: 'missing',
      title: 'X',
    })
    expect(listDeliveries(dir)).toEqual([])
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'workspace.unknown' } })
  })

  it('flags the pr:merge notice only once per workspace (later creates — even after cancel — do not)', () => {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg())
    expect((h.sent[0] as { prMergeNotice?: boolean }).prMergeNotice).toBe(true)
    createDeliveryHandler(h.ctx, h.conn, createMsg({ title: 'B' }))
    expect((h.sent[1] as { prMergeNotice?: boolean }).prMergeNotice).toBe(false)
    // Cancel the first, then create again — still not first.
    const first = listDeliveries(dir)[1]
    cancelDeliveryHandler(h.ctx, h.conn, {
      type: 'cancel_delivery',
      workspaceId,
      deliveryId: first.id,
    })
    createDeliveryHandler(h.ctx, h.conn, createMsg({ title: 'C' }))
    const frames = h.sent.filter((f) => f.type === 'create_delivery_result') as {
      prMergeNotice: boolean
    }[]
    expect(frames.map((f) => f.prMergeNotice)).toEqual([true, false, false])
  })
})

describe('list_deliveries — server-computed badge', () => {
  it('replies with the workspace list + needsActionCount (badge rule, not plan total)', () => {
    createDeliveryHandler(harness().ctx, harness().conn, createMsg())
    // A second workspace delivery keeps everything planned → no action.
    const h = harness()
    listDeliveriesHandler(h.ctx, h.conn, { type: 'list_deliveries', workspaceId })
    expect(h.sent[0]).toMatchObject({ type: 'deliveries', workspaceId, needsActionCount: 0 })
  })
})

describe('get_delivery_detail', () => {
  // Async since the detail also reports how far mainline is ahead of the delivery
  // branch — a local ref read, never a fetch.
  it('returns the delivery with a server-computed transition plan', async () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const h = harness()
    await getDeliveryDetailHandler(h.ctx, h.conn, { type: 'get_delivery_detail', deliveryId: id })
    const frame = h.sent[0] as Extract<ServerToClient, { type: 'delivery_detail' }>
    expect(frame.delivery.id).toBe(id)
    expect(frame.transitionPlan.targets).toEqual([
      {
        to: 'integrating',
        humanAction: true,
        guard: 'failed',
        reasons: [{ code: 'delivery.guard.branchNotReady', jumpTo: 'branch' }],
      },
    ])
  })

  it('errors on an unknown delivery', () => {
    const h = harness()
    getDeliveryDetailHandler(h.ctx, h.conn, { type: 'get_delivery_detail', deliveryId: 'nope' })
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.notFound' } })
  })
})

describe('update_delivery', () => {
  it('edits data fields and re-broadcasts', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const h = harness()
    updateDeliveryHandler(h.ctx, h.conn, {
      type: 'update_delivery',
      workspaceId,
      deliveryId: id,
      title: 'Renamed',
      startDate: 123,
    })
    expect(getDelivery(id)).toMatchObject({ title: 'Renamed', startDate: 123, status: 'planned' })
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
  })

  it('refuses to touch another workspace delivery', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const otherDir = mkdtempSync(join(tmpdir(), 'c3-delivery-other-'))
    try {
      addWorkspace(otherDir, 1)
      const otherId = pathToId(otherDir)!
      expect(otherId).not.toBe(workspaceId)
      const h = harness()
      updateDeliveryHandler(h.ctx, h.conn, {
        type: 'update_delivery',
        workspaceId: otherId,
        deliveryId: id,
        title: 'X',
      })
      expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.notFound' } })
      expect(getDelivery(id)!.title).toBe('Sprint 3')
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

describe('transition + cancel — the status write path', () => {
  it('applies a legal human transition and re-broadcasts', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const h = harness()
    transitionDeliveryHandler(h.ctx, h.conn, {
      type: 'transition_delivery',
      workspaceId,
      deliveryId: id,
      to: 'cancelled',
    })
    expect(getDelivery(id)!.status).toBe('cancelled')
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
    const frame = h.sent[0] as Extract<ServerToClient, { type: 'delivery_detail' }>
    expect(frame.delivery.status).toBe('cancelled')
  })

  it('refuses an illegal transition with invalidStatusTransition and leaves status unchanged', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const h = harness()
    transitionDeliveryHandler(h.ctx, h.conn, {
      type: 'transition_delivery',
      workspaceId,
      deliveryId: id,
      to: 'delivered', // planned → delivered is not in the graph
    })
    expect(getDelivery(id)!.status).toBe('planned')
    expect(h.sent[0]).toMatchObject({
      type: 'delivery_transition_failed',
      code: 'delivery.invalidStatusTransition',
      currentStatus: 'planned',
      reasons: [],
    })
  })

  it('refuses a guard-blocked transition with transitionGuardFailed + gap reasons', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    // Branch never becomes ready this phase → planned → integrating always blocked.
    const h = harness()
    transitionDeliveryHandler(h.ctx, h.conn, {
      type: 'transition_delivery',
      workspaceId,
      deliveryId: id,
      to: 'integrating',
    })
    expect(getDelivery(id)!.status).toBe('planned')
    const frame = h.sent[0] as Extract<ServerToClient, { type: 'delivery_transition_failed' }>
    expect(frame.code).toBe('delivery.transitionGuardFailed')
    expect(frame.reasons.map((r) => r.code)).toContain('delivery.guard.branchNotReady')
  })

  it('rejects a cross-workspace write', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const otherDir = mkdtempSync(join(tmpdir(), 'c3-delivery-other-'))
    try {
      addWorkspace(otherDir, 1)
      const otherId = pathToId(otherDir)!
      const h = harness()
      transitionDeliveryHandler(h.ctx, h.conn, {
        type: 'transition_delivery',
        workspaceId: otherId,
        deliveryId: id,
        to: 'cancelled',
      })
      expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.notFound' } })
      expect(getDelivery(id)!.status).toBe('planned')
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('lets verifying → verified pass once association facts exist and the human confirms', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    // Directly stage the facts this phase cannot produce (branch + associations),
    // then verify the machine + handler honor a confirmed verifying → verified.
    getDbRawUpdate(id, 'integrating', true)
    upsertIntentPr({ intentId: 'i1', deliveryId: id, number: '1', status: 'merged' })
    const h = harness()
    transitionDeliveryHandler(h.ctx, h.conn, {
      type: 'transition_delivery',
      workspaceId,
      deliveryId: id,
      to: 'verifying',
    })
    expect(getDelivery(id)!.status).toBe('verifying')
    transitionDeliveryHandler(h.ctx, h.conn, {
      type: 'transition_delivery',
      workspaceId,
      deliveryId: id,
      to: 'verified',
      confirmVerified: true,
    })
    expect(getDelivery(id)!.status).toBe('verified')
  })

  it('cancel is refused on a terminal delivery', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    cancelDeliveryHandler(h0.ctx, h0.conn, { type: 'cancel_delivery', workspaceId, deliveryId: id })
    const h = harness()
    cancelDeliveryHandler(h.ctx, h.conn, { type: 'cancel_delivery', workspaceId, deliveryId: id })
    expect(h.sent[0]).toMatchObject({
      type: 'delivery_transition_failed',
      code: 'delivery.invalidStatusTransition',
    })
  })
})

describe('delivery:* lifecycle events', () => {
  it('create_delivery publishes delivery:created with the base branch snapshot', () => {
    saveWorkspaceSetting(dir, { gitBranchMode: 'worktree', defaultMainBranch: 'develop' })
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg())
    const created = listDeliveries(dir)[0]

    expect(publishedTypes(h.published)).toEqual(['delivery:created'])
    expect(h.published[0]).toMatchObject({ workspacePath: dir })
    expect(h.published[0].event.metadata).toMatchObject({
      deliveryId: created.id,
      title: 'Sprint 3',
      baseBranch: 'develop',
    })
  })

  it('a human transition publishes status_changed carrying the from/to edge', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    getDbRawUpdate(id, 'integrating', true)
    upsertIntentPr({ intentId: 'i1', deliveryId: id, number: '1', status: 'merged' })

    const h = harness()
    transitionDeliveryHandler(h.ctx, h.conn, {
      type: 'transition_delivery',
      workspaceId,
      deliveryId: id,
      to: 'verifying',
    })
    expect(publishedTypes(h.published)).toEqual(['delivery:status_changed'])
    expect(h.published[0].event.metadata).toMatchObject({
      deliveryId: id,
      title: 'Sprint 3',
      from: 'integrating',
      to: 'verifying',
    })
  })

  it('cancelling double-publishes status_changed AND delivery:cancelled', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id

    const h = harness()
    cancelDeliveryHandler(h.ctx, h.conn, { type: 'cancel_delivery', workspaceId, deliveryId: id })
    expect(publishedTypes(h.published)).toEqual(['delivery:status_changed', 'delivery:cancelled'])
    expect(h.published[0].event.metadata).toMatchObject({ from: 'planned', to: 'cancelled' })
    expect(h.published[1].event.metadata).toMatchObject({ deliveryId: id, title: 'Sprint 3' })
  })

  it('a refused transition publishes nothing', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const h = harness()
    transitionDeliveryHandler(h.ctx, h.conn, {
      type: 'transition_delivery',
      workspaceId,
      deliveryId: id,
      to: 'delivered',
    })
    expect(h.published).toEqual([])
  })

  it('a publish failure never rolls back the committed status write', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const h = harness()
    ;(h.ctx as unknown as { normalizeEvent: () => unknown }).normalizeEvent = () => ({
      ok: false,
      reason: 'test refusal',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cancelDeliveryHandler(h.ctx, h.conn, { type: 'cancel_delivery', workspaceId, deliveryId: id })

    expect(getDelivery(id)!.status).toBe('cancelled')
    expect(h.published).toEqual([])
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

/** Test-only: stage a delivery's branch_ready + status (facts only later phases set). */
function getDbRawUpdate(id: string, status: string, branchReady: boolean): void {
  getDb()!.run(
    'UPDATE deliveries SET status=?, branch_ready=? WHERE id=?',
    status,
    branchReady ? 1 : 0,
    id,
  )
}

// ---------------------------------------------------------------------------
// Branch lifecycle tests — drive the REAL git CLI against `dir` as a repo with a
// bare origin, exercising create / bind / orphan-defense / multi-repo / cleanup.
// ---------------------------------------------------------------------------

describe('create_delivery — multi-repo gate', () => {
  it('rejects creating a delivery in a multi-repo workspace (no transaction opened)', () => {
    // `dir` is not a git repo; a sub-repo makes it multi-repo.
    mkdirSync(join(dir, 'sub', '.git'), { recursive: true })
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg())
    expect(listDeliveries(dir)).toEqual([])
    expect(h.sent[0]).toMatchObject({
      type: 'error',
      error: { code: 'delivery.multiRepoUnsupported' },
    })
  })
})

describe('init_delivery_branch — create / bind / orphan / conflict', () => {
  let bare: string

  /** Make `dir` a git repo rooted at `main` with a bare origin (unique per test). */
  function initWorkspaceRepo(): void {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    writeFileSync(join(dir, 'README.md'), 'init\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    bare = join(dirname(dir), `${basename(dir)}-remote.git`)
    execFileSync('git', ['init', '--bare', '-q', bare], { cwd: dirname(dir) })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: dir })
  }

  function headOf(ref: string): string {
    return execFileSync('git', ['rev-parse', '--verify', ref], { cwd: dir, encoding: 'utf-8' })
      .toString()
      .trim()
  }

  function remoteHas(branch: string): boolean {
    return remoteHead(branch) !== null
  }

  function remoteHead(branch: string): string | null {
    const out = execFileSync('git', ['ls-remote', '--heads', bare, branch], {
      encoding: 'utf-8',
    })
      .toString()
      .trim()
    const line = out.split('\n').find((l) => l.endsWith(`refs/heads/${branch}`))
    return line ? line.split(/\s+/)[0] : null
  }

  /** Advance the remote main from a throwaway clone; returns the new remote tip. */
  function advanceRemoteMain(): string {
    const clone = join(dirname(dir), `${basename(dir)}-clone`)
    execFileSync('git', ['clone', '-q', bare, clone], { cwd: dirname(dir) })
    execFileSync('git', ['config', 'user.email', 'o@t.dev'], { cwd: clone })
    execFileSync('git', ['config', 'user.name', 'other'], { cwd: clone })
    writeFileSync(join(clone, 'OTHER.md'), 'x\n')
    execFileSync('git', ['add', '-A'], { cwd: clone })
    execFileSync('git', ['commit', '-q', '-m', 'other'], { cwd: clone })
    execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: clone })
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf-8' })
      .toString()
      .trim()
    rmSync(clone, { recursive: true, force: true })
    return tip
  }

  function seedDelivery(title = 'Sprint 3'): string {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg({ title }))
    return listDeliveries(dir)[0].id
  }

  function progressPhases(sent: ServerToClient[]): string[] {
    return sent
      .filter(
        (f): f is Extract<ServerToClient, { type: 'delivery_branch_init_progress' }> =>
          f.type === 'delivery_branch_init_progress',
      )
      .map((f) => f.phase)
  }

  it('creates the branch on the remote rooted at the fetched origin base and writes branch_ready', async () => {
    initWorkspaceRepo()
    const baseHead = headOf('origin/main')
    const id = seedDelivery()
    const h = harness()
    await initDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'delivery/abc-sprint-3',
      mode: 'create',
    })
    // Pushed branch exists on the remote AT the fetched baseline head.
    expect(remoteHead('delivery/abc-sprint-3')).toBe(baseHead)
    expect(getDelivery(id)).toMatchObject({
      branchName: 'delivery/abc-sprint-3',
      branchReady: true,
    })
    const result = h.sent.find(
      (f): f is Extract<ServerToClient, { type: 'delivery_branch_init_result' }> =>
        f.type === 'delivery_branch_init_result',
    )
    expect(result?.delivery.branchReady).toBe(true)
    // Progress frames advance fetching → creating → pushing.
    expect(progressPhases(h.sent)).toEqual(['fetching', 'creating', 'pushing'])
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
    expect(publishedTypes(h.published)).toEqual(['delivery:branch_ready'])
    expect(h.published[0].event.metadata).toMatchObject({
      deliveryId: id,
      title: 'Sprint 3',
      branch: 'delivery/abc-sprint-3',
    })
  })

  it('the orphan and bind routes publish branch_ready too; a refused init publishes nothing', async () => {
    initWorkspaceRepo()
    const idOf = (title: string): string => listDeliveries(dir).find((d) => d.title === title)!.id

    // Route — orphan adoption (the push landed, the DB write had not).
    seedDelivery('Sprint orphan')
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/delivery/orphan'], { cwd: dir })
    const h1 = harness()
    await initDeliveryBranchHandler(h1.ctx, h1.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: idOf('Sprint orphan'),
      branchName: 'delivery/orphan',
      mode: 'create',
    })
    expect(publishedTypes(h1.published)).toEqual(['delivery:branch_ready'])

    // Route — bind mode onto an existing remote branch.
    seedDelivery('Sprint bind')
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/delivery/bind-me'], { cwd: dir })
    const h2 = harness()
    await initDeliveryBranchHandler(h2.ctx, h2.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: idOf('Sprint bind'),
      branchName: 'delivery/bind-me',
      mode: 'bind',
    })
    expect(publishedTypes(h2.published)).toEqual(['delivery:branch_ready'])
    expect(h2.published[0].event.metadata).toMatchObject({ branch: 'delivery/bind-me' })

    // Route — a bind that is REFUSED (the remote branch does not exist).
    seedDelivery('Sprint miss')
    const h3 = harness()
    await initDeliveryBranchHandler(h3.ctx, h3.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: idOf('Sprint miss'),
      branchName: 'delivery/nope',
      mode: 'bind',
    })
    expect(h3.published).toEqual([])
  })

  it('idempotently binds an orphan (remote branch at the baseline head) without re-push', async () => {
    initWorkspaceRepo()
    const id = seedDelivery()
    const baseHead = headOf('origin/main')
    // Simulate "push succeeded, DB write failed": remote branch exists at the
    // exact baseline head, delivery still not ready.
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/delivery/orphan'], { cwd: dir })
    expect(remoteHead('delivery/orphan')).toBe(baseHead)
    const h = harness()
    await initDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'delivery/orphan',
      mode: 'create',
    })
    expect(getDelivery(id)).toMatchObject({ branchName: 'delivery/orphan', branchReady: true })
    // Orphan match → binding only (fetching + binding), no creating/pushing.
    expect(progressPhases(h.sent)).toEqual(['fetching', 'binding'])
  })

  it('reports delivery.branchConflict when the remote branch exists at a DIFFERENT head (never overwrites)', async () => {
    initWorkspaceRepo()
    const id = seedDelivery()
    // Someone else's branch already exists at the ORIGINAL main head, then the
    // remote main advances — so the fetched baseline no longer matches the
    // existing branch: a conflict, never overwritten.
    execFileSync('git', ['push', '-q', 'origin', 'main:refs/heads/delivery/conflict'], { cwd: dir })
    const original = remoteHead('delivery/conflict')
    advanceRemoteMain()
    expect(remoteHead('main')).not.toBe(original)
    const h = harness()
    await initDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'delivery/conflict',
      mode: 'create',
    })
    const err = h.sent.find(
      (f): f is Extract<ServerToClient, { type: 'error' }> => f.type === 'error',
    )
    expect(err?.error.code).toBe('delivery.branchConflict')
    expect(getDelivery(id)!.branchReady).toBe(false)
  })

  it('binds an existing remote branch in bind mode; divergence is only a warning', async () => {
    initWorkspaceRepo()
    const id = seedDelivery()
    // `release/2026-08` at the ORIGINAL main head, then remote main advances → the
    // bound branch lags the freshly-fetched baseline (warning, not rejection).
    execFileSync('git', ['push', '-q', 'origin', 'main:refs/heads/release/2026-08'], { cwd: dir })
    const original = remoteHead('release/2026-08')
    advanceRemoteMain()
    expect(remoteHead('main')).not.toBe(original)
    const h = harness()
    await initDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'release/2026-08',
      mode: 'bind',
    })
    expect(getDelivery(id)).toMatchObject({ branchName: 'release/2026-08', branchReady: true })
    const result = h.sent.find(
      (f): f is Extract<ServerToClient, { type: 'delivery_branch_init_result' }> =>
        f.type === 'delivery_branch_init_result',
    )
    expect(result?.warning).toBe('delivery.branchBehindMain')
    expect(progressPhases(h.sent)).toEqual(['fetching', 'binding'])
  })

  it('refuses bind when the remote branch does not exist', async () => {
    initWorkspaceRepo()
    const id = seedDelivery()
    const h = harness()
    await initDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'release/nope',
      mode: 'bind',
    })
    const err = h.sent.find(
      (f): f is Extract<ServerToClient, { type: 'error' }> => f.type === 'error',
    )
    expect(err?.error.code).toBe('delivery.branchNotFound')
    expect(getDelivery(id)!.branchReady).toBe(false)
  })

  it('refuses bind when another ACTIVE delivery already holds the branch', async () => {
    initWorkspaceRepo()
    // The shared branch must actually EXIST on the remote before either bind.
    execFileSync('git', ['push', '-q', 'origin', 'main:refs/heads/release/x'], { cwd: dir })
    const a = seedDelivery('A')
    await initDeliveryBranchHandler(harness().ctx, harness().conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: a,
      branchName: 'release/x',
      mode: 'bind',
    })
    const b = seedDelivery('B')
    const h = harness()
    await initDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: b,
      branchName: 'release/x',
      mode: 'bind',
    })
    const err = h.sent.find(
      (f): f is Extract<ServerToClient, { type: 'error' }> => f.type === 'error',
    )
    expect(err?.error.code).toBe('delivery.branchConflict')
    expect(getDelivery(b)!.branchReady).toBe(false)
  })

  it('rejects a multi-repo workspace before any git command', async () => {
    // Seed the delivery FIRST (create also rejects multi-repo), then make the
    // workspace multi-repo for the init gate to reject.
    const id = seedDelivery()
    mkdirSync(join(dir, 'sub', '.git'), { recursive: true })
    const h = harness()
    await initDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'delivery/x',
      mode: 'create',
    })
    const err = h.sent.find(
      (f): f is Extract<ServerToClient, { type: 'error' }> => f.type === 'error',
    )
    expect(err?.error.code).toBe('delivery.multiRepoUnsupported')
    expect(getDelivery(id)!.branchReady).toBe(false)
  })

  it('is idempotent when already bound to the same branch (no git work)', async () => {
    initWorkspaceRepo()
    const id = seedDelivery()
    await initDeliveryBranchHandler(harness().ctx, harness().conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'delivery/abc-sprint-3',
      mode: 'create',
    })
    const h = harness()
    await initDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'delivery/abc-sprint-3',
      mode: 'create',
    })
    // No progress frames — the shortcut returned the current delivery.
    expect(progressPhases(h.sent)).toEqual([])
    expect(h.sent[0]).toMatchObject({ type: 'delivery_branch_init_result' })
  })
})

describe('cleanup_delivery_branch — terminal manual cleanup', () => {
  let bare: string
  let remoteHas: (branch: string) => boolean

  function seedDelivery(title = 'Sprint 3'): string {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg({ title }))
    return listDeliveries(dir)[0].id
  }

  beforeEach(() => {
    // `dir` as a git repo rooted at `main` with a bare origin, so branch init
    // and the local-ref cleanup can run against real git.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    writeFileSync(join(dir, 'README.md'), 'init\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    bare = join(dirname(dir), `${basename(dir)}-cleanup-remote.git`)
    execFileSync('git', ['init', '--bare', '-q', bare], { cwd: dirname(dir) })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: dir })
    remoteHas = (branch: string) => {
      const out = execFileSync('git', ['ls-remote', '--heads', bare, branch], {
        encoding: 'utf-8',
      })
        .toString()
        .trim()
      return out.includes(`refs/heads/${branch}`)
    }
  })

  it('clears the local ref of a terminal delivery and never touches the remote', async () => {
    const id = seedDelivery()
    await initDeliveryBranchHandler(harness().ctx, harness().conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: id,
      branchName: 'delivery/abc-sprint-3',
      mode: 'create',
    })
    expect(getDelivery(id)!.branchName).toBe('delivery/abc-sprint-3')
    // Deliver it (terminal), then clean up.
    getDbRawUpdate(id, 'delivered', true)
    const h = harness()
    await cleanupDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'cleanup_delivery_branch',
      workspaceId,
      deliveryId: id,
    })
    expect(getDelivery(id)).toMatchObject({ branchName: null, branchReady: false })
    // Remote branch is preserved.
    expect(remoteHas('delivery/abc-sprint-3')).toBe(true)
    // Local branch reference was deleted.
    expect(() =>
      execFileSync('git', ['rev-parse', '--verify', 'delivery/abc-sprint-3'], { cwd: dir }),
    ).toThrow()
    // Detail re-broadcast.
    expect(h.sent[0]).toMatchObject({ type: 'delivery_detail' })
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
  })

  it('refuses cleanup on a non-terminal delivery', async () => {
    const id = seedDelivery()
    const h = harness()
    await cleanupDeliveryBranchHandler(h.ctx, h.conn, {
      type: 'cleanup_delivery_branch',
      workspaceId,
      deliveryId: id,
    })
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.cleanupForbidden' } })
    expect(getDelivery(id)!.branchName).toBeNull()
  })
})

describe('link / unlink intent ↔ delivery', () => {
  let bare: string

  /** `dir` becomes a repo on `main` with a bare origin; returns nothing. */
  function initWorkspaceRepo(): void {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    writeFileSync(join(dir, 'README.md'), 'init\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    bare = join(dirname(dir), `${basename(dir)}-remote.git`)
    execFileSync('git', ['init', '--bare', '-q', bare], { cwd: dirname(dir) })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: dir })
  }

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).toString().trim()
  }

  function seedDelivery(title = 'Sprint 3'): string {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, createMsg({ title }))
    return listDeliveries(dir).find((d) => d.title === title)!.id
  }

  function seedIntent(title = 'Alpha'): string {
    return insertIntents(dir, [
      { title, shortEnTitle: title, content: '', priority: 'P2', module: '' },
    ])[0].id
  }

  async function link(deliveryId: string, intentId: string) {
    const h = harness()
    await linkIntentToDeliveryHandler(h.ctx, h.conn, {
      type: 'link_intent_to_delivery',
      workspaceId,
      deliveryId,
      intentId,
    })
    return h
  }

  async function unlink(deliveryId: string, intentId: string) {
    const h = harness()
    await unlinkIntentFromDeliveryHandler(h.ctx, h.conn, {
      type: 'unlink_intent_from_delivery',
      workspaceId,
      deliveryId,
      intentId,
    })
    return h
  }

  const errorCode = (sent: ServerToClient[]): string | undefined =>
    sent.find((f): f is Extract<ServerToClient, { type: 'error' }> => f.type === 'error')?.error
      .code

  const detail = (sent: ServerToClient[]) =>
    sent.find(
      (f): f is Extract<ServerToClient, { type: 'delivery_detail' }> =>
        f.type === 'delivery_detail',
    )

  beforeEach(() => {
    vi.mocked(getForgePrStatus).mockReset()
    vi.mocked(closeForgePr).mockReset()
  })

  it('links an intent, replies with the detail + associated list, and broadcasts both sides', async () => {
    const d = seedDelivery()
    const i = seedIntent()

    const h = await link(d, i)
    expect(detail(h.sent)?.associatedIntents).toEqual([
      { id: i, title: 'Alpha', status: 'todo', prStatus: null, headBranch: null },
    ])
    expect(detail(h.sent)?.linkWarning).toBeUndefined()
    expect(h.broadcastDeliveries).toHaveBeenCalledWith(dir)
    expect(h.broadcastIntents).toHaveBeenCalledWith(dir)
    expect(isIntentLinked(d, i)).toBe(true)
  })

  it('refuses a duplicate link with intentAlreadyLinked', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    await link(d, i)
    const again = await link(d, i)
    expect(errorCode(again.sent)).toBe('delivery.intentAlreadyLinked')
  })

  it('rejects an unknown intent and an unknown delivery', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    expect(errorCode((await link(d, 'missing')).sent)).toBe('intent.notFound')
    expect(errorCode((await link('missing', i)).sent)).toBe('delivery.notFound')
  })

  it('warns about diff bloat when the intent branched off mainline PAST the delivery fork point', async () => {
    initWorkspaceRepo()
    const d = seedDelivery()
    // Delivery branch rooted at the CURRENT main head.
    const hInit = harness()
    await initDeliveryBranchHandler(hInit.ctx, hInit.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: d,
      branchName: 'delivery/sprint-3',
      mode: 'create',
    })
    expect(getDelivery(d)?.branchReady).toBe(true)

    // Mainline moves on, and the intent branches off THERE — its PR into the
    // delivery branch would drag the whole main-vs-delivery difference along.
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, 'MAIN.md'), 'moved on\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'main moves')
    git('push', '-q', 'origin', 'main')
    git('checkout', '-q', '-b', 'feat/late')
    writeFileSync(join(dir, 'FEAT.md'), 'work\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'feat')
    const intentHead = git('rev-parse', 'HEAD')

    const i = seedIntent()
    setLatestCommitHash(i, intentHead)
    const h = await link(d, i)
    expect(detail(h.sent)?.linkWarning).toBe('delivery.diffBloat')
    // The warning never blocks: the edge is there.
    expect(isIntentLinked(d, i)).toBe(true)
  })

  it('does not warn when the intent branched off the delivery branch itself', async () => {
    initWorkspaceRepo()
    const d = seedDelivery()
    const hInit = harness()
    await initDeliveryBranchHandler(hInit.ctx, hInit.conn, {
      type: 'init_delivery_branch',
      workspaceId,
      deliveryId: d,
      branchName: 'delivery/sprint-3',
      mode: 'create',
    })
    git('checkout', '-q', '-b', 'feat/early', 'delivery/sprint-3')
    writeFileSync(join(dir, 'FEAT.md'), 'work\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'feat')
    const intentHead = git('rev-parse', 'HEAD')

    const i = seedIntent()
    setLatestCommitHash(i, intentHead)
    expect(detail((await link(d, i)).sent)?.linkWarning).toBeUndefined()
  })

  it('unlinks an intent that has no PR toward the delivery, without touching the forge', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    await link(d, i)

    const h = await unlink(d, i)
    expect(errorCode(h.sent)).toBeUndefined()
    expect(detail(h.sent)?.associatedIntents).toEqual([])
    expect(isIntentLinked(d, i)).toBe(false)
    expect(vi.mocked(getForgePrStatus)).not.toHaveBeenCalled()
    expect(vi.mocked(closeForgePr)).not.toHaveBeenCalled()
  })

  it('refuses to unlink a LOCALLY merged PR, without asking the forge', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    await link(d, i)
    upsertIntentPr({
      intentId: i,
      deliveryId: d,
      forge: 'github',
      repo: 'o/r',
      number: '7',
      status: 'merged',
    })

    const h = await unlink(d, i)
    expect(errorCode(h.sent)).toBe('delivery.unlinkMergedPrDenied')
    expect(isIntentLinked(d, i)).toBe(true)
    expect(vi.mocked(getForgePrStatus)).not.toHaveBeenCalled()
  })

  it('refuses when the forge says merged even though the ledger says reviewing — and syncs the ledger', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    await link(d, i)
    upsertIntentPr({
      intentId: i,
      deliveryId: d,
      forge: 'github',
      repo: 'o/r',
      number: '7',
      status: 'reviewing',
    })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'merged' })

    const h = await unlink(d, i)
    expect(errorCode(h.sent)).toBe('delivery.unlinkMergedPrDenied')
    expect(isIntentLinked(d, i)).toBe(true)
    expect(vi.mocked(closeForgePr)).not.toHaveBeenCalled()
    // The ledger now agrees, so a retry is refused locally without a round trip.
    expect(listIntentPrs(i)[0].status).toBe('merged')
    expect(listAssociatedIntents(d)[0].prStatus).toBe('merged')
  })

  it('blocks the unlink when the forge status cannot be read at all', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    await link(d, i)
    upsertIntentPr({
      intentId: i,
      deliveryId: d,
      forge: 'github',
      repo: 'o/r',
      number: '7',
      status: 'reviewing',
    })
    vi.mocked(getForgePrStatus).mockResolvedValue({
      ok: false,
      unavailable: true,
      error: 'gh CLI 未安装',
    })

    const h = await unlink(d, i)
    expect(errorCode(h.sent)).toBe('delivery.unlinkPrStatusCheckFailed')
    expect(isIntentLinked(d, i)).toBe(true)
    expect(vi.mocked(closeForgePr)).not.toHaveBeenCalled()
  })

  it('closes a confirmed-unmerged PR, deletes its row, drops the edge and lowers total', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    await link(d, i)
    upsertIntentPr({
      intentId: i,
      deliveryId: d,
      forge: 'github',
      repo: 'o/r',
      number: '7',
      status: 'reviewing',
    })
    expect(getDelivery(d)?.integration).toEqual({ total: 1, merged: 0 })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'reviewing' })
    vi.mocked(closeForgePr).mockResolvedValue({ ok: true })

    const h = await unlink(d, i)
    expect(vi.mocked(closeForgePr)).toHaveBeenCalledWith(dir, '7', 'github')
    expect(errorCode(h.sent)).toBeUndefined()
    expect(isIntentLinked(d, i)).toBe(false)
    expect(listIntentPrs(i)).toEqual([])
    // The aggregate and the associated list agree — no ghost row keeps counting.
    expect(detail(h.sent)?.delivery.integration).toEqual({ total: 0, merged: 0 })
    expect(detail(h.sent)?.associatedIntents).toEqual([])
    expect(h.broadcastIntents).toHaveBeenCalledWith(dir)
  })

  it('treats an already-closed PR as a successful close', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    await link(d, i)
    upsertIntentPr({
      intentId: i,
      deliveryId: d,
      forge: 'github',
      repo: 'o/r',
      number: '7',
      status: 'reviewing',
    })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'closed' })
    // `closeForgePr` absorbs the "not open" error itself; from here it is ok.
    vi.mocked(closeForgePr).mockResolvedValue({ ok: true })

    const h = await unlink(d, i)
    expect(errorCode(h.sent)).toBeUndefined()
    expect(isIntentLinked(d, i)).toBe(false)
    expect(listIntentPrs(i)).toEqual([])
  })

  it('blocks the whole unlink when closing the PR fails — edge and PR row both stay', async () => {
    const d = seedDelivery()
    const i = seedIntent()
    await link(d, i)
    upsertIntentPr({
      intentId: i,
      deliveryId: d,
      forge: 'github',
      repo: 'o/r',
      number: '7',
      status: 'reviewing',
    })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'reviewing' })
    vi.mocked(closeForgePr).mockResolvedValue({ ok: false, error: 'network down' })

    const h = await unlink(d, i)
    expect(errorCode(h.sent)).toBe('delivery.unlinkClosePrFailed')
    expect(isIntentLinked(d, i)).toBe(true)
    expect(listIntentPrs(i)).toHaveLength(1)
    expect(getDelivery(d)?.integration).toEqual({ total: 1, merged: 0 })
  })

  it('only touches the PR toward THIS delivery, leaving the other delivery intact', async () => {
    const d1 = seedDelivery('Sprint 3')
    const d2 = seedDelivery('Sprint 4')
    const i = seedIntent()
    await link(d1, i)
    await link(d2, i)
    upsertIntentPr({
      intentId: i,
      deliveryId: d1,
      forge: 'github',
      repo: 'o/r',
      number: '1',
      status: 'reviewing',
    })
    upsertIntentPr({
      intentId: i,
      deliveryId: d2,
      forge: 'github',
      repo: 'o/r',
      number: '2',
      status: 'reviewing',
    })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'reviewing' })
    vi.mocked(closeForgePr).mockResolvedValue({ ok: true })

    await unlink(d1, i)
    expect(vi.mocked(closeForgePr)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(closeForgePr)).toHaveBeenCalledWith(dir, '1', 'github')
    expect(isIntentLinked(d1, i)).toBe(false)
    expect(isIntentLinked(d2, i)).toBe(true)
    expect(listAssociatedIntents(d2)[0].prStatus).toBe('reviewing')
  })

  it('drops the edge when the intent is permanently deleted, and keeps it when the delivery is cancelled', async () => {
    const dDeleted = seedDelivery('Sprint 3')
    const dCancelled = seedDelivery('Sprint 4')
    const iDeleted = seedIntent('Alpha')
    const iKept = seedIntent('Beta')
    await link(dDeleted, iDeleted)
    await link(dCancelled, iKept)

    deleteIntentRecords(iDeleted)
    expect(isIntentLinked(dDeleted, iDeleted)).toBe(false)

    const h = harness()
    cancelDeliveryHandler(h.ctx, h.conn, {
      type: 'cancel_delivery',
      workspaceId,
      deliveryId: dCancelled,
    })
    expect(getDelivery(dCancelled)?.status).toBe('cancelled')
    expect(isIntentLinked(dCancelled, iKept)).toBe(true)
    expect(listAssociatedIntents(dCancelled).map((r) => r.id)).toEqual([iKept])
  })
})
