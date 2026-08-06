/**
 * Integration tests for the delivery store over the shared c3.db adapter.
 *
 * Covers: schema creation + the two constraints (status CHECK, active
 * `(workspace_path, branch_name)` partial-unique), CRUD (create/list/get/
 * update/status), the first-delivery `pr:merge` notice decided inside the create
 * transaction, and the real-time N/M aggregate derived from `intent_prs`
 * (`delivery_id` — the association surface the intent store already owns).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { upsertIntentPr, resetStoreForTests as resetIntentStoreForTests } from '../intents/store.js'
import {
  activeDeliveryHoldsBranch,
  clearDeliveryBranch,
  createDelivery,
  getDelivery,
  integrationAggregate,
  isStoreAvailable,
  listDeliveries,
  resetStoreForTests,
  setDeliveryBranch,
  setDeliveryStatus,
  updateDelivery,
} from './store.js'

let dir: string
const projA = '/abs/project-a'
const projB = '/abs/project-b'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-delivery-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetIntentStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function seed(workspacePath: string, title = 'T', baseBranch = 'main') {
  return createDelivery({
    workspacePath,
    title,
    description: '',
    startDate: null,
    endDate: null,
    baseBranch,
  })
}

describe('deliveries store — schema + constraints', () => {
  it('exposes the store and creates the table lazily', () => {
    expect(isStoreAvailable()).toBe(true)
    expect(listDeliveries(projA)).toEqual([])
  })

  it('rejects an out-of-domain status at the database CHECK', () => {
    const d = seed(projA)
    expect(() =>
      getDb()!.run(
        `INSERT INTO deliveries
           (id, workspace_path, title, description, status, start_date, end_date,
            branch_name, base_branch, branch_ready, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        'x',
        projA,
        'X',
        '',
        'done',
        null,
        null,
        null,
        'main',
        0,
        1,
        1,
      ),
    ).toThrow()
    expect(listDeliveries(projA).map((x) => x.id)).toEqual([d.delivery.id])
  })

  it('enforces (workspace, branch) uniqueness only among active states', () => {
    const a = seed(projA)
    const b = seed(projA, 'B')
    const d = getDb()!
    // First active delivery takes the branch.
    d.run('UPDATE deliveries SET branch_name=? WHERE id=?', 'feature/x', a.delivery.id)
    // A second ACTIVE delivery may not reuse it.
    expect(() =>
      d.run('UPDATE deliveries SET branch_name=? WHERE id=?', 'feature/x', b.delivery.id),
    ).toThrow()
    // A terminal delivery may — terminal rows do not hold the slot.
    d.run(
      "UPDATE deliveries SET status='delivered', branch_name=? WHERE id=?",
      'feature/x',
      a.delivery.id,
    )
    expect(() =>
      d.run('UPDATE deliveries SET branch_name=? WHERE id=?', 'feature/x', b.delivery.id),
    ).not.toThrow()
    // Different workspaces never conflict.
    const c = seed(projB, 'C')
    expect(() =>
      d.run('UPDATE deliveries SET branch_name=? WHERE id=?', 'feature/x', c.delivery.id),
    ).not.toThrow()
  })
})

describe('deliveries store — CRUD', () => {
  it('creates a planned delivery with the base-branch snapshot and branch not ready', () => {
    const { delivery, prMergeNotice } = seed(projA, 'Sprint 3', 'develop')
    expect(prMergeNotice).toBe(true)
    expect(delivery).toMatchObject({
      title: 'Sprint 3',
      description: '',
      status: 'planned',
      baseBranch: 'develop',
      branchReady: false,
      branchName: null,
      startDate: null,
      endDate: null,
      integration: { total: 0, merged: 0 },
    })
    expect(typeof delivery.id).toBe('string')
  })

  it('flags only the very first delivery in a workspace (cancelled still counts)', () => {
    expect(seed(projA).prMergeNotice).toBe(true)
    expect(seed(projA, 'B').prMergeNotice).toBe(false)
    // Cancelling does NOT free the "not first" fact: a re-create never re-notices.
    setDeliveryStatus(seed(projA, 'C').delivery.id, 'cancelled')
    expect(seed(projA, 'D').prMergeNotice).toBe(false)
  })

  it('lists per workspace, most-recently-updated first', () => {
    const a = seed(projA, 'A')
    seed(projB, 'B')
    const second = seed(projA, 'A2')
    const items = listDeliveries(projA)
    expect(items.map((x) => x.id)).toEqual([second.delivery.id, a.delivery.id])
    expect(listDeliveries(projB).map((x) => x.title)).toEqual(['B'])
  })

  it('normalizes the workspace path on write and read', () => {
    const { delivery } = createDelivery({
      workspacePath: '/abs/project-a/', // trailing slash
      title: 'T',
      description: '',
      startDate: null,
      endDate: null,
      baseBranch: 'main',
    })
    expect(listDeliveries('/abs/project-a').map((x) => x.id)).toEqual([delivery.id])
    expect(getDelivery(delivery.id)!.id).toBe(delivery.id)
  })

  it('updates data fields and bumps updated_at', () => {
    const { delivery } = seed(projA)
    const updated = updateDelivery(delivery.id, { title: 'New', startDate: 123 })
    expect(updated).toMatchObject({ title: 'New', startDate: 123, endDate: null })
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(delivery.updatedAt)
    // Untouched fields keep their values.
    expect(updated!.baseBranch).toBe('main')
    expect(updated!.status).toBe('planned')
    // Null explicitly clears a date.
    expect(updateDelivery(delivery.id, { startDate: null })!.startDate).toBeNull()
  })

  it('update / status write on an unknown id returns null', () => {
    expect(updateDelivery('missing', { title: 'X' })).toBeNull()
    expect(setDeliveryStatus('missing', 'cancelled')).toBeNull()
  })

  it('applies a status write (the caller owns the state-machine gate)', () => {
    const { delivery } = seed(projA)
    const updated = setDeliveryStatus(delivery.id, 'integrating')
    expect(updated!.status).toBe('integrating')
    expect(getDelivery(delivery.id)!.status).toBe('integrating')
  })
})

describe('integration aggregate — derived from intent_prs, never persisted', () => {
  it('reads 0/0 with no associations, and never passes the guard from 0/0', () => {
    const { delivery } = seed(projA)
    expect(integrationAggregate(delivery.id)).toEqual({ total: 0, merged: 0 })
  })

  it('counts merged PRs per associated intent, scoped to THIS delivery', () => {
    const d1 = seed(projA).delivery
    const d2 = seed(projA, 'other').delivery
    // d1: two associated intents, one merged.
    upsertIntentPr({
      intentId: 'i1',
      deliveryId: d1.id,
      number: '1',
      status: 'merged',
      forge: 'github',
      repo: 'o/r',
    })
    upsertIntentPr({
      intentId: 'i2',
      deliveryId: d1.id,
      number: '2',
      status: 'reviewing',
      forge: 'github',
      repo: 'o/r',
    })
    // d2's PR must not leak into d1's aggregate.
    upsertIntentPr({
      intentId: 'i3',
      deliveryId: d2.id,
      number: '3',
      status: 'merged',
      forge: 'github',
      repo: 'o/r',
    })
    expect(integrationAggregate(d1.id)).toEqual({ total: 2, merged: 1 })
    // All merged.
    upsertIntentPr({ intentId: 'i2', deliveryId: d1.id, number: '2', status: 'merged' })
    expect(integrationAggregate(d1.id)).toEqual({ total: 2, merged: 2 })
    expect(integrationAggregate(d2.id)).toEqual({ total: 1, merged: 1 })
  })
})

describe('deliveries store — branch lifecycle writes', () => {
  it('setDeliveryBranch records branch_name + branch_ready in one write', () => {
    const { delivery } = seed(projA)
    const updated = setDeliveryBranch(delivery.id, 'delivery/abc-sprint-3', true)
    expect(updated).toMatchObject({
      branchName: 'delivery/abc-sprint-3',
      branchReady: true,
      status: 'planned',
    })
    expect(getDelivery(delivery.id)!.branchReady).toBe(true)
  })

  it('setDeliveryBranch returns null on an unknown id', () => {
    expect(setDeliveryBranch('missing', 'delivery/x', true)).toBeNull()
  })

  it('activeDeliveryHoldsBranch spots an active holder, ignores self and terminals', () => {
    const a = seed(projA).delivery
    const b = seed(projA, 'B').delivery
    setDeliveryBranch(a.id, 'feature/x', true)

    expect(activeDeliveryHoldsBranch(projA, 'feature/x', a.id)).toBe(false) // self excluded
    expect(activeDeliveryHoldsBranch(projA, 'feature/x', b.id)).toBe(true) // other active holds it

    // A terminal holder frees the slot.
    setDeliveryStatus(a.id, 'delivered')
    expect(activeDeliveryHoldsBranch(projA, 'feature/x', b.id)).toBe(false)
    // Different workspace never conflicts.
    const c = seed(projB, 'C').delivery
    setDeliveryBranch(c.id, 'feature/x', true)
    expect(activeDeliveryHoldsBranch(projA, 'feature/x', b.id)).toBe(false)
  })

  it('clearDeliveryBranch releases the name + readiness of a terminal delivery', () => {
    const { delivery } = seed(projA)
    setDeliveryBranch(delivery.id, 'delivery/old', true)
    setDeliveryStatus(delivery.id, 'delivered')

    const cleared = clearDeliveryBranch(delivery.id)
    expect(cleared).toMatchObject({ branchName: null, branchReady: false, status: 'delivered' })

    // The released name is now reusable by another ACTIVE delivery.
    const b = seed(projA, 'B').delivery
    expect(() => setDeliveryBranch(b.id, 'delivery/old', true)).not.toThrow()
  })

  it('clearDeliveryBranch returns null on an unknown id', () => {
    expect(clearDeliveryBranch('missing')).toBeNull()
  })
})
