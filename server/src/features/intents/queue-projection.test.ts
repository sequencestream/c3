/**
 * Queue detail projection — the read model the queue page renders.
 *
 * Two things are asserted here. The ONE field that must never be remembered: the
 * queue position — every other fact falls back to the persisted decision log when
 * the current pass said nothing about an intent, because a stale reason is still
 * true while a stale POSITION is not. And the CANDIDATE rule, which must match the
 * scheduler's exactly: an intent whose work is done but whose PR is still in the
 * review relay is still queue business, and dropping its row would let the page
 * claim the queue finished work it is still driving.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueDecision } from '../../kernel/queue/index.js'

interface FakeIntent {
  id: string
  title: string
  status: string
  automate: boolean
  prs: { status: string }[]
  reviewStatus: string | null
  impactLevel: string | null
}

const intents: FakeIntent[] = []

function fake(over: Partial<FakeIntent> & { id: string }): FakeIntent {
  return {
    title: over.id,
    status: 'todo',
    automate: true,
    prs: [],
    reviewStatus: null,
    impactLevel: null,
    ...over,
  }
}
let latest: Record<string, Record<string, unknown>> = {}

vi.mock('./store.js', () => ({
  isStoreAvailable: () => true,
  listIntents: () => intents,
}))

vi.mock('./queue-store.js', () => ({
  getQueueControl: () => ({ state: 'running', startedAt: 0, forceSkipped: [] }),
  getQueueIntentMeta: () => ({}),
  latestQueueDecisionByIntent: () => latest,
}))

const { buildQueueDetail } = await import('./queue-projection.js')

function decision(over: Partial<QueueDecision> & { intentId: string }): QueueDecision {
  return {
    action: 'block',
    reason: 'blocked_concurrency_gate',
    detail: '',
    attemptCount: 0,
    backoffCount: 0,
    nextWakeupAt: null,
    queuePosition: null,
    ...over,
  }
}

function build(decisions: QueueDecision[]) {
  return buildQueueDetail('/w', {
    state: 'awaiting_gate',
    tickId: 't',
    nextWakeupAt: null,
    decisions,
  })
}

const positionOf = (detail: ReturnType<typeof build>, id: string) =>
  detail.items.find((i) => i.intentId === id)?.queuePosition

describe('buildQueueDetail — queue position', () => {
  beforeEach(() => {
    intents.length = 0
    intents.push(fake({ id: 'A' }), fake({ id: 'B' }))
    latest = {}
  })

  it('carries the position the kernel decided this pass', () => {
    const detail = build([
      decision({ intentId: 'A', queuePosition: 1 }),
      decision({ intentId: 'B', queuePosition: 2 }),
    ])
    expect(positionOf(detail, 'A')).toBe(1)
    expect(positionOf(detail, 'B')).toBe(2)
  })

  it('re-sorts when the next pass changes the line', () => {
    expect(positionOf(build([decision({ intentId: 'B', queuePosition: 2 })]), 'B')).toBe(2)
    expect(positionOf(build([decision({ intentId: 'B', queuePosition: 1 })]), 'B')).toBe(1)
  })

  it('clears the position once the gate releases, instead of keeping the old one', () => {
    expect(positionOf(build([decision({ intentId: 'A', queuePosition: 1 })]), 'A')).toBe(1)
    const released = build([decision({ intentId: 'A', action: 'launch', reason: 'selected' })])
    expect(positionOf(released, 'A')).toBeNull()
  })

  it('never revives a position from the persisted decision log', () => {
    // The log keeps the reason and the wake-up — a position was never stored, so
    // an intent this pass did not decide on shows no place in line.
    latest = {
      A: {
        intentId: 'A',
        action: 'block',
        blockedGate: 'blocked_concurrency_gate',
        rejectReason: '全局并发闸门',
        nextWakeupAt: 1234,
        decidedAt: 99,
        attemptCount: 0,
        backoffCount: 0,
      },
    }
    const detail = build([])
    const a = detail.items.find((i) => i.intentId === 'A')!
    expect(a.blockedReason).toBe('blocked_concurrency_gate')
    expect(a.queuePosition).toBeNull()
  })
})

describe('buildQueueDetail — the relay shares the scheduler’s candidate rule', () => {
  beforeEach(() => {
    intents.length = 0
    latest = {}
  })

  const ids = () => build([]).items.map((i) => i.intentId)

  it('keeps a done intent whose PR is still under review', () => {
    intents.push(
      fake({
        id: 'relaying',
        status: 'done',
        prs: [{ status: 'reviewing' }],
        reviewStatus: 'pending',
      }),
    )
    expect(ids()).toEqual(['relaying'])
  })

  it('drops it once the review is approved', () => {
    intents.push(
      fake({
        id: 'approved',
        status: 'done',
        prs: [{ status: 'reviewing' }],
        reviewStatus: 'approved',
      }),
    )
    expect(ids()).toEqual([])
  })

  it('drops a done L5 intent that needs no review at all', () => {
    intents.push(
      fake({ id: 'cosmetic', status: 'done', prs: [{ status: 'reviewing' }], impactLevel: 'L5' }),
    )
    expect(ids()).toEqual([])
  })

  it('drops a done intent whose PRs all reached a terminal', () => {
    intents.push(
      fake({ id: 'landed', status: 'done', prs: [{ status: 'merged' }], reviewStatus: 'pending' }),
    )
    expect(ids()).toEqual([])
  })

  it('shows a relay intent parked for a spent fix budget', () => {
    intents.push(
      fake({
        id: 'stuck',
        status: 'done',
        prs: [{ status: 'reviewing' }],
        reviewStatus: 'rejected',
      }),
    )
    expect(ids()).toEqual(['stuck'])
  })
})
