/**
 * create-intent-view — the create-intent overlay's pure state machine.
 *
 * What it must guarantee: the overlay is visible from the submit, its four steps
 * only ever move forward on the client cadence (and park on the last one rather
 * than claiming a completion nobody observed), and every terminal (success /
 * refusal / safety timeout) closes it — a stuck overlay would block the whole page.
 */
import { describe, expect, it } from 'vitest'
import {
  beginCreateIntent,
  createIntentStepStatuses,
  reduceCreateIntent,
  shouldToastCreateIntentFailure,
  CREATE_INTENT_MIN_DWELL_MS,
  CREATE_INTENT_SAFETY_TIMEOUT_MS,
  CREATE_INTENT_STAGE_DWELL_MS,
  CREATE_INTENT_STEPS,
  type CreateIntentModel,
} from './create-intent-view'

/** A model whose current step has just lit up at t=0. */
function settled(phase: CreateIntentModel['phase'] = 'fetch-branch'): CreateIntentModel {
  return { ...beginCreateIntent(0), phase }
}

const AFTER_DWELL = CREATE_INTENT_MIN_DWELL_MS
const REFUSAL = { code: 'workspace.unknown', message: 'unknown workspace' }

describe('beginCreateIntent', () => {
  it('is visible on the first step from the submit', () => {
    const m = beginCreateIntent(1_000)
    expect(m).toEqual({
      phase: 'fetch-branch',
      startedAt: 1_000,
      visibleAt: 1_000,
      stageAt: 1_000,
    })
    expect(createIntentStepStatuses(m.phase)).toEqual(['active', 'pending', 'pending', 'pending'])
  })
})

describe('step mapping', () => {
  it('lights each step in turn with the earlier ones done', () => {
    expect(createIntentStepStatuses('prepare-worktree')).toEqual([
      'done',
      'active',
      'pending',
      'pending',
    ])
    expect(createIntentStepStatuses('create-intent')).toEqual(['done', 'done', 'active', 'pending'])
    expect(createIntentStepStatuses('open-session')).toEqual(['done', 'done', 'done', 'active'])
  })

  it('marks every step done on success and none active on failure', () => {
    expect(createIntentStepStatuses('done')).toEqual(Array(CREATE_INTENT_STEPS.length).fill('done'))
    expect(createIntentStepStatuses('failed')).toEqual(
      Array(CREATE_INTENT_STEPS.length).fill('pending'),
    )
  })
})

describe('stage cadence', () => {
  it('advances one step once the current one has been shown long enough', () => {
    const tr = reduceCreateIntent(settled(), { kind: 'advance', now: CREATE_INTENT_STAGE_DWELL_MS })
    expect(tr.model).toMatchObject({
      phase: 'prepare-worktree',
      stageAt: CREATE_INTENT_STAGE_DWELL_MS,
    })
  })

  it('holds the step when the tick fired before its dwell elapsed', () => {
    const tr = reduceCreateIntent(settled(), { kind: 'advance', now: 10 })
    expect(tr.model?.phase).toBe('fetch-branch')
  })

  it('walks the whole chain one step per dwell and then parks on the last step', () => {
    let model = beginCreateIntent(0)
    for (const [i, step] of CREATE_INTENT_STEPS.slice(1).entries()) {
      const tr = reduceCreateIntent(model, {
        kind: 'advance',
        now: (i + 1) * CREATE_INTENT_STAGE_DWELL_MS,
      })
      model = tr.model as CreateIntentModel
      expect(model.phase).toBe(step)
    }
    // The wait really ends here, so further ticks change nothing.
    const parked = reduceCreateIntent(model, {
      kind: 'advance',
      now: 10 * CREATE_INTENT_STAGE_DWELL_MS,
    })
    expect(parked.model?.phase).toBe('open-session')
  })

  it('stops narrating once a terminal is held for the dwell', () => {
    const held = reduceCreateIntent(settled(), { kind: 'done', now: 10 })
    const tick = reduceCreateIntent(held.model, {
      kind: 'advance',
      now: 10 + CREATE_INTENT_STAGE_DWELL_MS,
    })
    expect(tick.model).toMatchObject({ phase: 'done', pendingCloseReason: 'done' })
  })

  it('drops every event once the overlay is closed', () => {
    expect(reduceCreateIntent(null, { kind: 'advance', now: 10 })).toEqual({ model: null })
    expect(reduceCreateIntent(null, { kind: 'done', now: 10 })).toEqual({ model: null })
  })
})

describe('terminals', () => {
  it('closes on success once the dwell has elapsed', () => {
    const tr = reduceCreateIntent(settled('open-session'), { kind: 'done', now: AFTER_DWELL })
    expect(tr).toEqual({ model: null, closedReason: 'done' })
  })

  it('closes on a refusal once the dwell has elapsed', () => {
    const tr = reduceCreateIntent(settled('prepare-worktree'), {
      kind: 'failed',
      ...REFUSAL,
      now: AFTER_DWELL,
    })
    expect(tr).toEqual({ model: null, closedReason: 'failed' })
  })

  it('holds a fast terminal until the minimum dwell, then closes with its reason', () => {
    const held = reduceCreateIntent(settled('create-intent'), { kind: 'done', now: 10 })
    expect(held.closedReason).toBeUndefined()
    expect(held.model).toMatchObject({ phase: 'done', pendingCloseReason: 'done' })

    const closed = reduceCreateIntent(held.model, { kind: 'dwell-complete', now: AFTER_DWELL })
    expect(closed).toEqual({ model: null, closedReason: 'done' })
  })

  it('keeps the first terminal when a second one follows', () => {
    const held = reduceCreateIntent(settled(), { kind: 'failed', ...REFUSAL, now: 10 })
    const second = reduceCreateIntent(held.model, { kind: 'done', now: 20 })
    expect(second.model).toMatchObject({ phase: 'failed', pendingCloseReason: 'failed' })
    expect(second.closedReason).toBeUndefined()
  })

  it('does not close on a dwell tick that fired early', () => {
    const held = reduceCreateIntent(settled(), { kind: 'done', now: 10 })
    const early = reduceCreateIntent(held.model, { kind: 'dwell-complete', now: 20 })
    expect(early.model).not.toBeNull()
    expect(early.closedReason).toBeUndefined()
  })

  it('ignores a dwell tick with no terminal pending', () => {
    const tr = reduceCreateIntent(settled(), { kind: 'dwell-complete', now: AFTER_DWELL })
    expect(tr.model).not.toBeNull()
    expect(tr.closedReason).toBeUndefined()
  })

  it('closes on the safety timeout when the ceiling has elapsed', () => {
    const tr = reduceCreateIntent(settled('open-session'), {
      kind: 'timeout',
      now: CREATE_INTENT_SAFETY_TIMEOUT_MS,
    })
    expect(tr).toEqual({ model: null, closedReason: 'timeout' })
  })

  it('ignores a timeout tick fired before the ceiling', () => {
    const tr = reduceCreateIntent(settled('open-session'), { kind: 'timeout', now: 1_000 })
    expect(tr.model).not.toBeNull()
    expect(tr.closedReason).toBeUndefined()
  })
})

describe('failure toast de-duplication', () => {
  it('stays silent for refusals that already have a presentation', () => {
    // The intent-action error dialog spells these out; `agent.*` already toasts.
    expect(shouldToastCreateIntentFailure('intent.baseBranchRequired')).toBe(false)
    expect(shouldToastCreateIntentFailure('intent.createFailed')).toBe(false)
    expect(shouldToastCreateIntentFailure('agent.groupUnavailable')).toBe(false)
  })

  it('toasts refusals the intents page would otherwise show nowhere', () => {
    expect(shouldToastCreateIntentFailure('workspace.unknown')).toBe(true)
    expect(shouldToastCreateIntentFailure('delivery.guard.branchNotReady')).toBe(true)
  })
})
