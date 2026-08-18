/**
 * Feature-level tests for the `cancel_discussion` handler over a real temp c3.db +
 * registered workspace.
 *
 * Contract under test:
 *  - a `draft` (research may still be running) and an `in_progress` discussion both
 *    terminate as `cancelled`, with the refreshed list pushed;
 *  - whatever is alive for that discussion is torn down through the shared abort
 *    path — the orchestration loop (a paused one is woken so it observes the abort
 *    instead of parking on its gate) and/or the read-only research run;
 *  - a torn-down orchestration appends nothing more: the loop's own `signal.aborted`
 *    guards already own that, so the assertion here is that the signal is aborted
 *    while the transcript is left exactly as it was;
 *  - `completed` / `cancelled` are terminal and are rejected with an error rather
 *    than silently rewriting a conclusion's status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'
import { cancelDiscussion } from './index.js'
import {
  appendMessage,
  createDiscussion,
  getDiscussion,
  listMessages,
  resetStoreForTests,
  updateDiscussionStatus,
} from './store.js'
import {
  deleteDiscussionRun,
  deleteResearchRun,
  setDiscussionRun,
  setResearchRun,
  type DiscussionRunControl,
} from './run-controls.js'

let dir: string
let workspaceName: string
const liveIds: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-disc-cancel-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceName = pathToName(dir)!
})

afterEach(() => {
  for (const id of liveIds) {
    deleteDiscussionRun(id)
    deleteResearchRun(id)
  }
  liveIds.length = 0
  resetDbForTests()
  resetStateCacheForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const sent: ServerToClient[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m) } as unknown as Conn
  const broadcastDiscussions = vi.fn()
  const ctx = { broadcastDiscussions } as unknown as KernelContext
  return { sent, conn, ctx, broadcastDiscussions }
}

/** A persisted discussion in the temp workspace, defaulting to `draft`. */
function seed(status: 'draft' | 'in_progress' | 'completed' | 'cancelled' = 'draft'): string {
  const d = createDiscussion({
    workspacePath: dir,
    title: 'T',
    type: 'design',
    goal: 'G',
    context: '',
    participantAgentIds: [],
    organizerAgentId: null,
    status: 'draft',
  })
  if (status !== 'draft') updateDiscussionStatus(d.id, status)
  return d.id
}

/** Register a live orchestration run for `id` (cleaned up after each test). */
function liveRun(id: string, paused = false): DiscussionRunControl {
  const ctrl: DiscussionRunControl = { abort: new AbortController(), paused, resumeWaiters: [] }
  setDiscussionRun(id, ctrl)
  liveIds.push(id)
  return ctrl
}

const cancelMsg = (discussionId: string) => ({ type: 'cancel_discussion' as const, discussionId })

describe('cancel_discussion', () => {
  it('cancels a draft with no live run and pushes the refreshed list', () => {
    const id = seed('draft')
    const h = harness()

    cancelDiscussion(h.ctx, h.conn, cancelMsg(id))

    expect(getDiscussion(id)?.status).toBe('cancelled')
    expect(h.broadcastDiscussions).toHaveBeenCalledWith(dir)
    expect(h.sent).toEqual([])
  })

  it('aborts a draft’s live research run (so it cannot write back or auto-start)', () => {
    const id = seed('draft')
    const research = new AbortController()
    setResearchRun(id, research)
    liveIds.push(id)
    const h = harness()

    cancelDiscussion(h.ctx, h.conn, cancelMsg(id))

    expect(research.signal.aborted).toBe(true)
    expect(getDiscussion(id)?.status).toBe('cancelled')
  })

  it('tears down an in_progress discussion’s live run and appends nothing more', () => {
    const id = seed('in_progress')
    appendMessage({
      discussionId: id,
      speakerKind: 'organizer',
      speakerAgentId: null,
      speakerName: 'Organizer',
      content: 'round 1',
    })
    const ctrl = liveRun(id)
    const h = harness()

    cancelDiscussion(h.ctx, h.conn, cancelMsg(id))

    expect(ctrl.abort.signal.aborted).toBe(true)
    expect(getDiscussion(id)?.status).toBe('cancelled')
    // The transcript is left exactly as it was — cancelling appends no message.
    expect(listMessages(id).map((m) => m.content)).toEqual(['round 1'])
  })

  it('wakes a paused run so it observes the abort instead of parking on its gate', () => {
    const id = seed('in_progress')
    const ctrl = liveRun(id, true)
    let woken = false
    ctrl.resumeWaiters.push(() => {
      woken = true
    })
    const h = harness()

    cancelDiscussion(h.ctx, h.conn, cancelMsg(id))

    expect(woken).toBe(true)
    expect(ctrl.abort.signal.aborted).toBe(true)
    expect(getDiscussion(id)?.status).toBe('cancelled')
  })

  it('cancels a dangling in_progress discussion that has no live run at all', () => {
    const id = seed('in_progress')
    const h = harness()

    cancelDiscussion(h.ctx, h.conn, cancelMsg(id))

    expect(getDiscussion(id)?.status).toBe('cancelled')
    expect(h.broadcastDiscussions).toHaveBeenCalledWith(dir)
  })

  it.each(['completed', 'cancelled'] as const)(
    'rejects a %s discussion with an error and leaves its status untouched',
    (status) => {
      const id = seed(status)
      const h = harness()

      cancelDiscussion(h.ctx, h.conn, cancelMsg(id))

      expect(h.sent).toEqual([{ type: 'error', error: { code: 'discussion.alreadyEnded' } }])
      expect(getDiscussion(id)?.status).toBe(status)
      expect(h.broadcastDiscussions).not.toHaveBeenCalled()
    },
  )

  it('rejects an unknown discussion id', () => {
    const h = harness()

    cancelDiscussion(h.ctx, h.conn, cancelMsg('nope'))

    expect(h.sent).toEqual([
      { type: 'error', error: { code: 'discussion.unknown', params: { id: 'nope' } } },
    ])
    expect(h.broadcastDiscussions).not.toHaveBeenCalled()
  })
})

// `workspaceName` is resolved by the handler from the stored discussion; assert the
// registration the seed relies on is what the broadcast target resolves to.
it('broadcasts to the discussion’s own workspace root', () => {
  const id = seed('draft')
  const h = harness()

  cancelDiscussion(h.ctx, h.conn, cancelMsg(id))

  expect(getDiscussion(id)?.workspaceName).toBe(workspaceName)
  expect(h.broadcastDiscussions).toHaveBeenCalledWith(dir)
})
