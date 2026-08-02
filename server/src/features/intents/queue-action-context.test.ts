/**
 * The action dispatch contract.
 *
 * The controller hands every kernel action to ONE table; these tests pin that
 * contract. Exhaustiveness is enforced at COMPILE time — `QueueActionExecutors`
 * is a mapped type over `QueueAction['kind']`, so a table missing a kind, or a
 * kernel that grows a kind without a registered executor, fails `tsc`. The
 * `@ts-expect-error` cases below are what makes that guarantee testable: if the
 * constraint were ever relaxed so a missing kind compiled, these lines would
 * fail instead, loudly.
 */
import { describe, expect, it, vi } from 'vitest'
import type { QueueAction } from '../../kernel/queue/index.js'
import { runQueueAction, type QueueActionExecutors } from './queue-action-context.js'

/** One action of every kind the kernel can emit, in a fixed order. */
const ALL_ACTIONS: QueueAction[] = [
  { kind: 'launch', intentId: 'A', origin: 'queue-kernel' },
  { kind: 'resume', intentId: 'B', sessionId: 's-1', origin: 'queue-kernel' },
  { kind: 'attach', intentId: 'C', sessionId: 's-2', origin: 'queue-kernel' },
  { kind: 'park', intentId: 'D', reason: 'permission_wait_timeout', detail: 'x' },
  { kind: 'wait_user_involve', intentId: 'E', reason: 'needs_human_decision', detail: 'y' },
  { kind: 'sync_dependency_prs', intentIds: ['F', 'G'] },
  { kind: 'launch_spec', intentId: 'H', origin: 'queue-kernel', rework: false, reworkRound: 0 },
  { kind: 'launch_spec_review', intentId: 'I', origin: 'queue-kernel', fingerprint: 'fp' },
  { kind: 'machine_approve_spec', intentId: 'J', fingerprint: 'fp' },
]

describe('the dispatch table is exhaustive over every QueueAction kind', () => {
  it('routes every kind to its registered executor, with the exact action object', () => {
    const seen: Array<{ kind: string; ref: QueueAction; now: number }> = []
    const register =
      (kind: string) =>
      (action: QueueAction, now: number): void => {
        seen.push({ kind, ref: action, now })
      }
    const table: QueueActionExecutors = {
      launch: register('launch'),
      resume: register('resume'),
      attach: register('attach'),
      park: register('park'),
      wait_user_involve: register('wait_user_involve'),
      sync_dependency_prs: register('sync_dependency_prs'),
      launch_spec: register('launch_spec'),
      launch_spec_review: register('launch_spec_review'),
      machine_approve_spec: register('machine_approve_spec'),
    }

    for (const action of ALL_ACTIONS) runQueueAction(table, action, 42)

    // Every kind dispatched exactly once, to the executor of the SAME kind,
    // with the identical action reference (no re-wrapping) and the pass clock.
    expect(seen.map((s) => s.kind)).toEqual(ALL_ACTIONS.map((a) => a.kind))
    seen.forEach((s, i) => {
      expect(s.ref).toBe(ALL_ACTIONS[i])
      expect(s.now).toBe(42)
    })
  })

  it('dispatches in the order the kernel produced the array', () => {
    const order: string[] = []
    const spy = vi.fn((kind: string) => order.push(kind))
    const table: QueueActionExecutors = {
      launch: (a) => void spy(a.kind),
      resume: (a) => void spy(a.kind),
      attach: (a) => void spy(a.kind),
      park: (a) => void spy(a.kind),
      wait_user_involve: (a) => void spy(a.kind),
      sync_dependency_prs: (a) => void spy(a.kind),
      launch_spec: (a) => void spy(a.kind),
      launch_spec_review: (a) => void spy(a.kind),
      machine_approve_spec: (a) => void spy(a.kind),
    }
    // A deliberately non-alphabetical order, as a real pass interleaves them.
    const shuffled = [ALL_ACTIONS[8], ALL_ACTIONS[0], ALL_ACTIONS[3], ALL_ACTIONS[6]]
    for (const action of shuffled) runQueueAction(table, action, 1)
    expect(order).toEqual(['machine_approve_spec', 'launch', 'park', 'launch_spec'])
  })

  it('COMPILE TIME: a table missing one kind is a type error', () => {
    // @ts-expect-error -- omitting `machine_approve_spec` must not compile.
    const incomplete: QueueActionExecutors = {
      launch: () => {},
      resume: () => {},
      attach: () => {},
      park: () => {},
      wait_user_involve: () => {},
      sync_dependency_prs: () => {},
      launch_spec: () => {},
      launch_spec_review: () => {},
    }
    expect(incomplete).toBeDefined()
  })

  it('COMPILE TIME: an executor receiving the wrong action shape is a type error', () => {
    const table: QueueActionExecutors = {
      launch: () => {},
      resume: () => {},
      attach: () => {},
      park: () => {},
      wait_user_involve: () => {},
      sync_dependency_prs: () => {},
      launch_spec: () => {},
      launch_spec_review: () => {},
      // @ts-expect-error -- `machine_approve_spec` carries a fingerprint, not intentIds.
      machine_approve_spec: (a: Extract<QueueAction, { kind: 'sync_dependency_prs' }>) => a,
    }
    expect(table).toBeDefined()
  })
})
