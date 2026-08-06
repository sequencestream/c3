/**
 * Feature-level tests for the delivery handlers over a real temp c3.db +
 * registered workspace: workspace-scoped create/list/detail/update, the
 * `base_branch` snapshot, the one-time `pr:merge` notice, cross-workspace
 * rejection, the status-machine write path (transition + cancel), and the
 * server-computed badge count on the list reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { saveWorkspaceSetting } from '../../kernel/config/index.js'
import { addWorkspace, pathToId, resetStateCacheForTests } from '../../state.js'
import {
  cancelDeliveryHandler,
  createDeliveryHandler,
  getDeliveryDetailHandler,
  listDeliveriesHandler,
  transitionDeliveryHandler,
  updateDeliveryHandler,
} from './index.js'
import { getDelivery, listDeliveries, resetStoreForTests } from './store.js'
import { upsertIntentPr, resetStoreForTests as resetIntentStoreForTests } from '../intents/store.js'

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

function harness() {
  const sent: ServerToClient[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m) } as unknown as Conn
  const broadcastDeliveries = vi.fn()
  const ctx = { broadcastDeliveries } as unknown as KernelContext
  return { sent, conn, ctx, broadcastDeliveries }
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
  it('returns the delivery with a server-computed transition plan', () => {
    const h0 = harness()
    createDeliveryHandler(h0.ctx, h0.conn, createMsg())
    const id = listDeliveries(dir)[0].id
    const h = harness()
    getDeliveryDetailHandler(h.ctx, h.conn, { type: 'get_delivery_detail', deliveryId: id })
    const frame = h.sent[0] as Extract<ServerToClient, { type: 'delivery_detail' }>
    expect(frame.delivery.id).toBe(id)
    expect(frame.transitionPlan.targets).toEqual([
      {
        to: 'integrating',
        humanAction: true,
        guard: 'failed',
        reasons: [{ code: 'delivery.guard.branchNotReady', jumpTo: 'workspace-settings' }],
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

/** Test-only: stage a delivery's branch_ready + status (facts only later phases set). */
function getDbRawUpdate(id: string, status: string, branchReady: boolean): void {
  getDb()!.run(
    'UPDATE deliveries SET status=?, branch_ready=? WHERE id=?',
    status,
    branchReady ? 1 : 0,
    id,
  )
}
