/**
 * The delivery audit trail: which actions leave a `delivery_logs` row, what that
 * row says, who it says did it, and — just as importantly — which actions leave
 * NOTHING behind.
 *
 * The two facts every case here is really about:
 *  - one successful business action appends exactly ONE line, never two and
 *    never zero;
 *  - a refused, guarded, duplicate or no-op action appends none, because the
 *    trail records what happened and nothing else.
 *
 * The `delivered` / `merge_conflict` lines are driven from the forge and live in
 * `delivery-pr.test.ts`, which owns those paths end to end.
 *
 * Only the two forge round-trips are mocked; everything else is the real store
 * over a real temp c3.db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeliveryStatus, ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'
import { closeForgePr, getForgePrStatus } from '../../git.js'
import {
  cancelDeliveryHandler,
  createDeliveryHandler,
  linkIntentToDeliveryHandler,
  listDeliveryLogsHandler,
  transitionDeliveryHandler,
  unlinkIntentFromDeliveryHandler,
  updateDeliveryHandler,
} from './index.js'
import {
  getDelivery,
  isIntentLinked,
  listDeliveries,
  listDeliveryLogs,
  resetStoreForTests,
} from './store.js'
import {
  insertIntents,
  listIntentPrs,
  upsertIntentPr,
  resetStoreForTests as resetIntentStoreForTests,
} from '../intents/store.js'

vi.mock('../../git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../git.js')>()),
  getForgePrStatus: vi.fn(),
  closeForgePr: vi.fn(),
}))

let dir: string
let workspaceName: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-delivery-logs-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3-home')
  process.env.CLAUDE_CONFIG_DIR = dir
  resetDbForTests()
  resetStoreForTests()
  resetIntentStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceName = pathToName(dir)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** A connection carrying an authenticated subject (or none, for the `system` case). */
function harness(subject: string | null = 'alice') {
  const sent: ServerToClient[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m), subject } as unknown as Conn
  const ctx = {
    broadcastDeliveries: vi.fn(),
    broadcastIntents: vi.fn(),
    normalizeEvent: (core: unknown) => ({ ok: true as const, event: core }),
    eventBus: { publish: vi.fn() },
  } as unknown as KernelContext
  return { sent, conn, ctx }
}

/** Create one delivery and return its id. */
function seedDelivery(subject: string | null = 'alice', title = 'Sprint 3'): string {
  const h = harness(subject)
  createDeliveryHandler(h.ctx, h.conn, {
    type: 'create_delivery',
    workspaceName,
    title,
    description: '',
  })
  return listDeliveries(dir).find((d) => d.title === title)!.id
}

function seedIntent(title: string): string {
  return insertIntents(dir, [{ title, shortEnTitle: title, content: '', priority: 'P2' }])[0].id
}

/** Stage the facts the guards read but this test file has no reason to produce. */
function stage(id: string, status: DeliveryStatus, branchReady = true): void {
  getDb()!.run(
    'UPDATE deliveries SET status=?, branch_ready=? WHERE id=?',
    status,
    branchReady ? 1 : 0,
    id,
  )
}

/** The operation types this delivery's trail holds, newest first. */
const ops = (id: string): string[] => listDeliveryLogs(id).map((l) => l.operationType)

function transition(
  id: string,
  to: DeliveryStatus,
  confirmVerified = false,
  subject: string | null = 'alice',
) {
  const h = harness(subject)
  transitionDeliveryHandler(h.ctx, h.conn, {
    type: 'transition_delivery',
    workspaceName,
    deliveryId: id,
    to,
    confirmVerified,
  })
  return h
}

describe('delivery_created', () => {
  it('appends exactly one line naming the delivery, attributed to the signed-in subject', () => {
    const id = seedDelivery('alice', 'Sprint 3')
    const logs = listDeliveryLogs(id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      deliveryId: id,
      operationType: 'delivery_created',
      actor: 'alice',
    })
    expect(logs[0].summary).toContain('Sprint 3')
  })

  it('falls back to `system` when the connection has no authenticated subject', () => {
    const id = seedDelivery(null, 'No subject')
    expect(listDeliveryLogs(id)[0].actor).toBe('system')
  })

  it('leaves no line when the create is refused (empty title)', () => {
    const h = harness()
    createDeliveryHandler(h.ctx, h.conn, {
      type: 'create_delivery',
      workspaceName,
      title: '   ',
      description: '',
    })
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.titleRequired' } })
    expect(listDeliveries(dir)).toEqual([])
  })
})

describe('delivery_updated', () => {
  it('names the fields that actually changed', () => {
    const id = seedDelivery()
    const h = harness('bob')
    updateDeliveryHandler(h.ctx, h.conn, {
      type: 'update_delivery',
      workspaceName,
      deliveryId: id,
      title: 'Sprint 4',
      startDate: 1_700_000_000_000,
    })
    const [latest] = listDeliveryLogs(id)
    expect(latest).toMatchObject({ operationType: 'delivery_updated', actor: 'bob' })
    expect(latest.summary).toContain('标题')
    expect(latest.summary).toContain('开始日期')
    // Untouched fields are not "changed" — an edit that never addressed them
    // must not claim it did.
    expect(latest.summary).not.toContain('描述')
    expect(latest.summary).not.toContain('结束日期')
  })

  it('writes nothing when the submitted values equal what the delivery already holds', () => {
    const id = seedDelivery('alice', 'Sprint 3')
    const h = harness()
    updateDeliveryHandler(h.ctx, h.conn, {
      type: 'update_delivery',
      workspaceName,
      deliveryId: id,
      title: 'Sprint 3',
      description: '',
      startDate: null,
      endDate: null,
    })
    expect(h.sent[0]).toMatchObject({ type: 'delivery_detail' })
    expect(ops(id)).toEqual(['delivery_created'])
  })

  it('writes nothing when the update is refused', () => {
    const id = seedDelivery()
    const h = harness()
    updateDeliveryHandler(h.ctx, h.conn, {
      type: 'update_delivery',
      workspaceName,
      deliveryId: id,
      title: '  ',
    })
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.titleRequired' } })
    expect(ops(id)).toEqual(['delivery_created'])
  })
})

describe('status edges — one line per committed edge, named by the action', () => {
  it('planned → integrating is a plain status change carrying both ends', () => {
    const id = seedDelivery()
    stage(id, 'planned')
    transition(id, 'integrating')
    const [latest] = listDeliveryLogs(id)
    expect(latest).toMatchObject({ operationType: 'status_changed', actor: 'alice' })
    expect(latest.summary).toContain('planned')
    expect(latest.summary).toContain('integrating')
  })

  it('integrating → verifying is a plain status change', () => {
    const id = seedDelivery()
    stage(id, 'integrating')
    upsertIntentPr({ intentId: 'i1', deliveryId: id, number: '1', status: 'merged' })
    transition(id, 'verifying')
    expect(getDelivery(id)!.status).toBe('verifying')
    const [latest] = listDeliveryLogs(id)
    expect(latest.operationType).toBe('status_changed')
    expect(latest.summary).toContain('integrating → verifying')
  })

  it('verifying → integrating (human rework) is a plain status change', () => {
    const id = seedDelivery()
    stage(id, 'verifying')
    transition(id, 'integrating')
    const [latest] = listDeliveryLogs(id)
    expect(latest.operationType).toBe('status_changed')
    expect(latest.summary).toContain('verifying → integrating')
  })

  it('verifying → verified is a verification confirmation, not a plain status change', () => {
    const id = seedDelivery()
    stage(id, 'verifying')
    upsertIntentPr({ intentId: 'i1', deliveryId: id, number: '1', status: 'merged' })
    transition(id, 'verified', true)
    expect(getDelivery(id)!.status).toBe('verified')
    const [latest] = listDeliveryLogs(id)
    expect(latest.operationType).toBe('verification_confirmed')
    expect(latest.summary).toContain('verifying → verified')
  })

  it.each<DeliveryStatus>(['planned', 'integrating', 'verifying', 'verified'])(
    'cancelling from %s is its own operation, not a plain status change',
    (from) => {
      const id = seedDelivery('alice', `cancel-from-${from}`)
      stage(id, from)
      const h = harness('carol')
      cancelDeliveryHandler(h.ctx, h.conn, {
        type: 'cancel_delivery',
        workspaceName,
        deliveryId: id,
      })
      expect(getDelivery(id)!.status).toBe('cancelled')
      const [latest] = listDeliveryLogs(id)
      expect(latest).toMatchObject({ operationType: 'cancelled', actor: 'carol' })
      expect(latest.summary).toContain(`${from} → cancelled`)
    },
  )

  it('an ILLEGAL edge is refused and leaves the trail untouched', () => {
    const id = seedDelivery()
    stage(id, 'planned')
    const h = transition(id, 'delivered')
    expect(h.sent[0]).toMatchObject({
      type: 'delivery_transition_failed',
      code: 'delivery.invalidStatusTransition',
    })
    expect(ops(id)).toEqual(['delivery_created'])
  })

  it('a legal edge refused BY A GUARD leaves the trail untouched', () => {
    const id = seedDelivery()
    // Branch not ready → `planned → integrating` is legal but blocked.
    stage(id, 'planned', false)
    const h = transition(id, 'integrating')
    expect(h.sent[0]).toMatchObject({
      type: 'delivery_transition_failed',
      code: 'delivery.transitionGuardFailed',
    })
    expect(getDelivery(id)!.status).toBe('planned')
    expect(ops(id)).toEqual(['delivery_created'])
  })

  it('a verifying → verified WITHOUT the human confirmation writes nothing', () => {
    const id = seedDelivery()
    stage(id, 'verifying')
    upsertIntentPr({ intentId: 'i1', deliveryId: id, number: '1', status: 'merged' })
    const h = transition(id, 'verified', false)
    expect(h.sent[0]).toMatchObject({ type: 'delivery_transition_failed' })
    expect(ops(id)).toEqual(['delivery_created'])
  })
})

describe('association edges', () => {
  it('a link appends one line naming the intent', async () => {
    const id = seedDelivery()
    const intentId = seedIntent('Add search')
    const h = harness('dave')
    await linkIntentToDeliveryHandler(h.ctx, h.conn, {
      type: 'link_intent_to_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    const [latest] = listDeliveryLogs(id)
    expect(latest).toMatchObject({ operationType: 'intent_linked', actor: 'dave' })
    expect(latest.summary).toContain('Add search')
  })

  it('a DUPLICATE link is refused and appends nothing', async () => {
    const id = seedDelivery()
    const intentId = seedIntent('Add search')
    const h1 = harness()
    await linkIntentToDeliveryHandler(h1.ctx, h1.conn, {
      type: 'link_intent_to_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    const h2 = harness()
    await linkIntentToDeliveryHandler(h2.ctx, h2.conn, {
      type: 'link_intent_to_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    expect(h2.sent[0]).toMatchObject({
      type: 'error',
      error: { code: 'delivery.intentAlreadyLinked' },
    })
    expect(ops(id)).toEqual(['intent_linked', 'delivery_created'])
  })

  it('an unlink with no PR appends one line naming the intent', async () => {
    const id = seedDelivery()
    const intentId = seedIntent('Add search')
    const h1 = harness()
    await linkIntentToDeliveryHandler(h1.ctx, h1.conn, {
      type: 'link_intent_to_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    const h2 = harness('erin')
    await unlinkIntentFromDeliveryHandler(h2.ctx, h2.conn, {
      type: 'unlink_intent_from_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    expect(isIntentLinked(id, intentId)).toBe(false)
    const [latest] = listDeliveryLogs(id)
    expect(latest).toMatchObject({ operationType: 'intent_unlinked', actor: 'erin' })
    expect(latest.summary).toContain('Add search')
  })

  it('an unlink whose PR is ALREADY closed on the forge still lands as one line, with the PR row', async () => {
    const id = seedDelivery()
    const intentId = seedIntent('Add search')
    const h1 = harness()
    await linkIntentToDeliveryHandler(h1.ctx, h1.conn, {
      type: 'link_intent_to_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    upsertIntentPr({ intentId, deliveryId: id, number: '7', status: 'reviewing' })
    // "Already closed remotely" is absorbed as success by `closeForgePr`, so the
    // retry converges on exactly one unlink line — not zero, and not two.
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'closed' })
    vi.mocked(closeForgePr).mockResolvedValue({ ok: true })

    const h2 = harness('erin')
    await unlinkIntentFromDeliveryHandler(h2.ctx, h2.conn, {
      type: 'unlink_intent_from_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    expect(isIntentLinked(id, intentId)).toBe(false)
    // The PR row went WITH the edge — the whole point of one transaction.
    expect(listIntentPrs(intentId).filter((p) => p.deliveryId === id)).toEqual([])
    expect(ops(id)).toEqual(['intent_unlinked', 'intent_linked', 'delivery_created'])
  })

  it('an unlink REFUSED by the merged-PR guard appends nothing and drops nothing', async () => {
    const id = seedDelivery()
    const intentId = seedIntent('Add search')
    const h1 = harness()
    await linkIntentToDeliveryHandler(h1.ctx, h1.conn, {
      type: 'link_intent_to_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    upsertIntentPr({ intentId, deliveryId: id, number: '7', status: 'merged' })

    const h2 = harness()
    await unlinkIntentFromDeliveryHandler(h2.ctx, h2.conn, {
      type: 'unlink_intent_from_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    expect(h2.sent[0]).toMatchObject({
      type: 'error',
      error: { code: 'delivery.unlinkMergedPrDenied' },
    })
    expect(isIntentLinked(id, intentId)).toBe(true)
    expect(ops(id)).toEqual(['intent_linked', 'delivery_created'])
  })

  it('an unlink whose PR close FAILS appends nothing and drops nothing', async () => {
    const id = seedDelivery()
    const intentId = seedIntent('Add search')
    const h1 = harness()
    await linkIntentToDeliveryHandler(h1.ctx, h1.conn, {
      type: 'link_intent_to_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    upsertIntentPr({ intentId, deliveryId: id, number: '7', status: 'reviewing' })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'reviewing' })
    vi.mocked(closeForgePr).mockResolvedValue({ ok: false, error: 'boom' })

    const h2 = harness()
    await unlinkIntentFromDeliveryHandler(h2.ctx, h2.conn, {
      type: 'unlink_intent_from_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    expect(h2.sent[0]).toMatchObject({
      type: 'error',
      error: { code: 'delivery.unlinkClosePrFailed' },
    })
    expect(isIntentLinked(id, intentId)).toBe(true)
    expect(listIntentPrs(intentId).filter((p) => p.deliveryId === id)).toHaveLength(1)
    expect(ops(id)).toEqual(['intent_linked', 'delivery_created'])
  })
})

describe('atomicity — the fact and its line land together or not at all', () => {
  /**
   * Make the audit insert fail without touching any business table. The store
   * ensures its schema once per connection, so a dropped table stays dropped for
   * the rest of this test.
   */
  function breakLogTable(): void {
    getDb()!.exec('DROP TABLE delivery_logs')
  }

  it('a failed log write rolls back the status change', () => {
    const id = seedDelivery()
    stage(id, 'planned')
    breakLogTable()
    expect(() => transition(id, 'integrating')).toThrow()
    expect(getDelivery(id)!.status).toBe('planned')
  })

  it('a failed log write rolls back a field edit', () => {
    const id = seedDelivery('alice', 'Sprint 3')
    breakLogTable()
    const h = harness()
    expect(() =>
      updateDeliveryHandler(h.ctx, h.conn, {
        type: 'update_delivery',
        workspaceName,
        deliveryId: id,
        title: 'Sprint 4',
      }),
    ).not.toThrow()
    // The handler converts the throw into an error frame; what matters is that
    // the title did not move.
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.updateFailed' } })
    expect(getDelivery(id)!.title).toBe('Sprint 3')
  })

  it('a failed log write rolls back the association edge', async () => {
    const id = seedDelivery()
    const intentId = seedIntent('Add search')
    breakLogTable()
    const h = harness()
    await linkIntentToDeliveryHandler(h.ctx, h.conn, {
      type: 'link_intent_to_delivery',
      workspaceName,
      deliveryId: id,
      intentId,
    })
    // The link primitive throws; the edge is absent, and the failure is reported
    // AS a failure — never mislabelled 「已关联」, which the ledger would deny.
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.linkFailed' } })
    expect(isIntentLinked(id, intentId)).toBe(false)
  })
})

describe('list_delivery_logs', () => {
  it('returns this delivery s trail newest-first, and nothing from another delivery', () => {
    const a = seedDelivery('alice', 'A')
    const b = seedDelivery('alice', 'B')
    const hu = harness()
    updateDeliveryHandler(hu.ctx, hu.conn, {
      type: 'update_delivery',
      workspaceName,
      deliveryId: a,
      title: 'A renamed',
    })

    const h = harness()
    listDeliveryLogsHandler(h.ctx, h.conn, { type: 'list_delivery_logs', deliveryId: a })
    const frame = h.sent[0] as Extract<ServerToClient, { type: 'delivery_logs_list' }>
    expect(frame.type).toBe('delivery_logs_list')
    expect(frame.deliveryId).toBe(a)
    // Newest first — the two rows share a millisecond, so only the insertion
    // order tiebreak can put them the right way round.
    expect(frame.items.map((i) => i.operationType)).toEqual([
      'delivery_updated',
      'delivery_created',
    ])
    expect(frame.items.every((i) => i.deliveryId === a)).toBe(true)

    const hb = harness()
    listDeliveryLogsHandler(hb.ctx, hb.conn, { type: 'list_delivery_logs', deliveryId: b })
    const frameB = hb.sent[0] as Extract<ServerToClient, { type: 'delivery_logs_list' }>
    expect(frameB.items.map((i) => i.operationType)).toEqual(['delivery_created'])
  })

  it('returns an empty list for a delivery that has no trail yet', () => {
    const id = seedDelivery()
    getDb()!.run('DELETE FROM delivery_logs WHERE delivery_id=?', id)
    const h = harness()
    listDeliveryLogsHandler(h.ctx, h.conn, { type: 'list_delivery_logs', deliveryId: id })
    expect(h.sent[0]).toMatchObject({ type: 'delivery_logs_list', deliveryId: id, items: [] })
  })

  it('refuses an unknown delivery rather than answering with an empty trail', () => {
    const h = harness()
    listDeliveryLogsHandler(h.ctx, h.conn, { type: 'list_delivery_logs', deliveryId: 'nope' })
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.notFound' } })
  })

  it('reports an unavailable database as such, not as an empty trail', () => {
    const id = seedDelivery()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    resetDbForTests()
    resetStoreForTests()
    const h = harness()
    listDeliveryLogsHandler(h.ctx, h.conn, { type: 'list_delivery_logs', deliveryId: id })
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'delivery.dbUnavailable' } })
  })
})
