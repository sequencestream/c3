/**
 * create-pr-view — the create-PR overlay's pure state machine.
 *
 * What it must guarantee: the overlay is visible from the click, its four steps
 * only ever move forward, and every terminal (success / failure / safety
 * timeout) closes it — a stuck overlay would block the whole page.
 */
import { describe, expect, it } from 'vitest'
import {
  beginCreatePr,
  createPrStepStatuses,
  reduceCreatePr,
  CREATE_PR_MIN_DWELL_MS,
  CREATE_PR_SAFETY_TIMEOUT_MS,
  CREATE_PR_STEPS,
  type CreatePrModel,
} from './create-pr-view'

/** The correlation token of the run under test. */
const REQ = 'r-1'

/** A model past its minimum dwell, so terminals resolve immediately. */
function settled(phase: CreatePrModel['phase'] = 'analyzing-changes'): CreatePrModel {
  return { ...beginCreatePr('i-1', REQ, 0), phase }
}

const AFTER_DWELL = CREATE_PR_MIN_DWELL_MS

describe('beginCreatePr', () => {
  it('is visible on the first step from the click', () => {
    const m = beginCreatePr('i-1', REQ, 1_000)
    expect(m).toEqual({
      intentId: 'i-1',
      requestId: REQ,
      phase: 'analyzing-changes',
      startedAt: 1_000,
      visibleAt: 1_000,
    })
    expect(createPrStepStatuses(m.phase)).toEqual(['active', 'pending', 'pending', 'pending'])
  })
})

describe('step mapping', () => {
  it('lights each stage in turn with the earlier steps done', () => {
    expect(createPrStepStatuses('committing')).toEqual(['done', 'active', 'pending', 'pending'])
    expect(createPrStepStatuses('pushing')).toEqual(['done', 'done', 'active', 'pending'])
    expect(createPrStepStatuses('creating-pr')).toEqual(['done', 'done', 'done', 'active'])
  })

  it('marks every step done on success and none active on failure', () => {
    expect(createPrStepStatuses('done')).toEqual(Array(CREATE_PR_STEPS.length).fill('done'))
    expect(createPrStepStatuses('failed')).toEqual(Array(CREATE_PR_STEPS.length).fill('pending'))
  })
})

describe('stage events', () => {
  it('advances the phase on a forward stage', () => {
    const tr = reduceCreatePr(settled(), {
      kind: 'stage',
      intentId: 'i-1',
      stage: 'committing',
      requestId: REQ,
      now: 10,
    })
    expect(tr.model?.phase).toBe('committing')
  })

  it('ignores a repeated stage', () => {
    const tr = reduceCreatePr(settled('pushing'), {
      kind: 'stage',
      intentId: 'i-1',
      stage: 'pushing',
      requestId: REQ,
      now: 10,
    })
    expect(tr.model?.phase).toBe('pushing')
  })

  it('never rewinds on an out-of-order stage', () => {
    const tr = reduceCreatePr(settled('creating-pr'), {
      kind: 'stage',
      intentId: 'i-1',
      stage: 'committing',
      requestId: REQ,
      now: 10,
    })
    expect(tr.model?.phase).toBe('creating-pr')
  })

  it('ignores progress for another intent', () => {
    const tr = reduceCreatePr(settled(), {
      kind: 'stage',
      intentId: 'other',
      stage: 'creating-pr',
      requestId: REQ,
      now: 10,
    })
    expect(tr.model?.phase).toBe('analyzing-changes')
  })

  it('ignores progress from a superseded run of the same intent', () => {
    const tr = reduceCreatePr(settled(), {
      kind: 'stage',
      intentId: 'i-1',
      stage: 'creating-pr',
      requestId: 'r-0',
      now: 10,
    })
    expect(tr.model?.phase).toBe('analyzing-changes')
  })

  it('drops every event once the overlay is closed', () => {
    const tr = reduceCreatePr(null, {
      kind: 'stage',
      intentId: 'i-1',
      stage: 'pushing',
      requestId: REQ,
      now: 10,
    })
    expect(tr).toEqual({ model: null })
  })
})

describe('terminals', () => {
  it('closes on success once the dwell has elapsed', () => {
    const tr = reduceCreatePr(settled('creating-pr'), {
      kind: 'done',
      requestId: REQ,
      now: AFTER_DWELL,
    })
    expect(tr).toEqual({ model: null, closedReason: 'done' })
  })

  it('closes on failure once the dwell has elapsed', () => {
    const tr = reduceCreatePr(settled('committing'), {
      kind: 'failed',
      requestId: REQ,
      now: AFTER_DWELL,
    })
    expect(tr).toEqual({ model: null, closedReason: 'failed' })
  })

  it('ignores an error frame that belongs to no request', () => {
    // Any other request on the connection can fail while the overlay is up; that
    // error is not this run's terminal and must not release the page early.
    const tr = reduceCreatePr(settled('pushing'), { kind: 'failed', now: AFTER_DWELL })
    expect(tr.model?.phase).toBe('pushing')
    expect(tr.closedReason).toBeUndefined()
  })

  it('ignores terminals from a superseded run after a retry', () => {
    // The safety timeout released the first run's overlay, the user clicked again,
    // and only then did the first run reply — for either outcome.
    const retried = settled('committing')
    const lateDone = reduceCreatePr(retried, { kind: 'done', requestId: 'r-0', now: AFTER_DWELL })
    expect(lateDone.model?.phase).toBe('committing')
    expect(lateDone.closedReason).toBeUndefined()

    const lateFail = reduceCreatePr(retried, { kind: 'failed', requestId: 'r-0', now: AFTER_DWELL })
    expect(lateFail.model?.phase).toBe('committing')
    expect(lateFail.closedReason).toBeUndefined()
  })

  it('holds a fast terminal until the minimum dwell, then closes with its reason', () => {
    const held = reduceCreatePr(settled('committing'), { kind: 'done', requestId: REQ, now: 10 })
    expect(held.closedReason).toBeUndefined()
    expect(held.model).toMatchObject({ phase: 'done', pendingCloseReason: 'done' })

    // A late stage frame must not disturb the held terminal.
    const noisy = reduceCreatePr(held.model, {
      kind: 'stage',
      intentId: 'i-1',
      stage: 'creating-pr',
      requestId: REQ,
      now: 20,
    })
    expect(noisy.model).toMatchObject({ phase: 'done', pendingCloseReason: 'done' })

    const closed = reduceCreatePr(noisy.model, { kind: 'dwell-complete', now: AFTER_DWELL })
    expect(closed).toEqual({ model: null, closedReason: 'done' })
  })

  it('keeps the first terminal when a second one follows', () => {
    const held = reduceCreatePr(settled(), { kind: 'failed', requestId: REQ, now: 10 })
    const second = reduceCreatePr(held.model, { kind: 'done', requestId: REQ, now: 20 })
    expect(second.model).toMatchObject({ phase: 'failed', pendingCloseReason: 'failed' })
    expect(second.closedReason).toBeUndefined()
  })

  it('does not close on a dwell tick that fired early', () => {
    const held = reduceCreatePr(settled(), { kind: 'done', requestId: REQ, now: 10 })
    const early = reduceCreatePr(held.model, { kind: 'dwell-complete', now: 20 })
    expect(early.model).not.toBeNull()
    expect(early.closedReason).toBeUndefined()
  })

  it('ignores a dwell tick with no terminal pending', () => {
    const tr = reduceCreatePr(settled(), { kind: 'dwell-complete', now: AFTER_DWELL })
    expect(tr.model).not.toBeNull()
    expect(tr.closedReason).toBeUndefined()
  })

  it('closes on the safety timeout when the ceiling has elapsed', () => {
    const tr = reduceCreatePr(settled('pushing'), {
      kind: 'timeout',
      now: CREATE_PR_SAFETY_TIMEOUT_MS,
    })
    expect(tr).toEqual({ model: null, closedReason: 'timeout' })
  })

  it('ignores a timeout tick fired before the ceiling', () => {
    const tr = reduceCreatePr(settled('pushing'), { kind: 'timeout', now: 1_000 })
    expect(tr.model).not.toBeNull()
    expect(tr.closedReason).toBeUndefined()
  })
})
