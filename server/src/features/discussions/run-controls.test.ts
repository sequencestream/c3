/**
 * Tests for the two teardown entries: `abortAllRuns` (graceful shutdown, everything)
 * and `abortDiscussionRuns` (one discussion — the `cancel_discussion` path).
 *
 * Shared contract: the live orchestration AND research runs in scope are aborted, a
 * paused loop is woken so it can observe that abort instead of parking on its gate,
 * and the call is idempotent (each run's own settle path is what removes its registry
 * entry). `abortDiscussionRuns` additionally must not touch any OTHER discussion's run.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  abortAllRuns,
  abortDiscussionRuns,
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

describe('abortDiscussionRuns', () => {
  it('aborts one discussion’s orchestration and research runs, and reports which were live', () => {
    const ctrl = liveDiscussion('c1')
    const research = new AbortController()
    setResearchRun('c1', research)
    ids.push('c1')

    expect(abortDiscussionRuns('c1')).toEqual({ discussion: true, research: true })
    expect(ctrl.abort.signal.aborted).toBe(true)
    expect(research.signal.aborted).toBe(true)
  })

  it('leaves every other discussion’s run alone', () => {
    const target = liveDiscussion('c2')
    const bystander = liveDiscussion('c3')
    const bystanderResearch = new AbortController()
    setResearchRun('c3', bystanderResearch)
    ids.push('c3')

    abortDiscussionRuns('c2')

    expect(target.abort.signal.aborted).toBe(true)
    expect(bystander.abort.signal.aborted).toBe(false)
    expect(bystanderResearch.signal.aborted).toBe(false)
  })

  it('wakes a paused loop so it observes the abort instead of parking on its gate', () => {
    const ctrl = liveDiscussion('c4', true)
    let woken = false
    ctrl.resumeWaiters.push(() => {
      woken = true
    })

    abortDiscussionRuns('c4')

    expect(woken).toBe(true)
    expect(ctrl.resumeWaiters).toEqual([])
    expect(ctrl.abort.signal.aborted).toBe(true)
  })

  it('reports both false for a discussion with nothing live (and does not throw)', () => {
    expect(abortDiscussionRuns('never-ran')).toEqual({ discussion: false, research: false })
  })
})
