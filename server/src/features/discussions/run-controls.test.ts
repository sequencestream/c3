/**
 * Tests for `abortAllRuns` — the teardown entry the graceful shutdown calls before
 * it awaits anything.
 *
 * Contract: every live orchestration AND research run is aborted, a paused loop is
 * woken so it can observe that abort instead of parking on its gate, and the call is
 * idempotent (each run's own settle path is what removes its registry entry).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  abortAllRuns,
  deleteDiscussionRun,
  deleteResearchRun,
  setDiscussionRun,
  setResearchRun,
  type DiscussionRunControl,
} from './run-controls.js'

const ids: string[] = []

function liveDiscussion(id: string, paused = false): DiscussionRunControl {
  const ctrl: DiscussionRunControl = { abort: new AbortController(), paused, resumeWaiters: [] }
  setDiscussionRun(id, ctrl)
  ids.push(id)
  return ctrl
}

afterEach(() => {
  for (const id of ids) {
    deleteDiscussionRun(id)
    deleteResearchRun(id)
  }
  ids.length = 0
})

describe('abortAllRuns', () => {
  it('aborts every live orchestration and research run, and reports the counts', () => {
    const orchestration = liveDiscussion('d1')
    const research = new AbortController()
    setResearchRun('d2', research)
    ids.push('d2')

    expect(abortAllRuns()).toEqual({ discussions: 1, research: 1 })
    expect(orchestration.abort.signal.aborted).toBe(true)
    expect(research.signal.aborted).toBe(true)
  })

  it('wakes a paused loop so it observes the abort instead of parking on its gate', () => {
    const ctrl = liveDiscussion('d3', true)
    let woken = false
    ctrl.resumeWaiters.push(() => {
      woken = true
    })

    abortAllRuns()

    expect(woken).toBe(true)
    expect(ctrl.resumeWaiters).toEqual([])
    expect(ctrl.abort.signal.aborted).toBe(true)
  })

  it('is idempotent — a second call over the same registry re-aborts without throwing', () => {
    const ctrl = liveDiscussion('d4')
    abortAllRuns()
    expect(abortAllRuns()).toEqual({ discussions: 1, research: 0 })
    expect(ctrl.abort.signal.aborted).toBe(true)
  })

  it('reports zeros when nothing is live', () => {
    expect(abortAllRuns()).toEqual({ discussions: 0, research: 0 })
  })
})
