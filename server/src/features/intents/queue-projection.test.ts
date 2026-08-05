/**
 * Queue detail projection — the read model the queue page renders.
 *
 * The focus here is the ONE field that must never be remembered: the queue
 * position. Every other fact falls back to the persisted decision log when the
 * current pass said nothing about an intent, because a stale reason is still
 * true; a stale POSITION is not — the line has been re-sorted since.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueDecision } from '../../kernel/queue/index.js'

const intents: { id: string; title: string; status: string; automate: boolean }[] = []
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
    intents.push(
      { id: 'A', title: 'A', status: 'todo', automate: true },
      { id: 'B', title: 'B', status: 'todo', automate: true },
    )
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
