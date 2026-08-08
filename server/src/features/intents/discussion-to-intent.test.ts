/**
 * `discussion_to_intent` — the concluded-discussion → intent bridge, which now
 * runs the SAME two steps as the "add intent" path: persist an empty `draft`
 * intent first, then bind an intent-OWNED communication session to it.
 *
 * Covers: the create-then-bind happy path (intent row, owner-carrying session
 * projection, `intent_session_id`, pending→intent link, `create_intent_result` +
 * `session_selected`), the shared first-turn prompt (discussion title/conclusion
 * plus the builder's in-place-update guard), the rejection branches (which must
 * create nothing), and the launch-failure unwind (session gone, intent kept and
 * still deletable).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Discussion, ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { removeRuntime } from '../../runs.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import {
  createDiscussion,
  resetStoreForTests as resetDiscussionStoreForTests,
  setConclusion,
} from '../discussions/store.js'
import {
  listOwnedForWorkspace,
  resetStoreForTests as resetSessionMetadataStoreForTests,
} from '../sessions/session-metadata-store.js'
import { buildIntentSessionFirstPrompt, deleteIntent, discussionToIntent } from './index.js'
import { getIntent, listIntents, resetStoreForTests } from './store.js'
import { resetForTests as resetIntentLink, takePendingIntentLink } from './intent-link.js'
import { initTestGitRepo } from '../../../test/git-repo.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-discussion-to-intent-'))
  initTestGitRepo(dir)
  process.env.CLAUDE_CONFIG_DIR = dir
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetDiscussionStoreForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetIntentLink()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetIntentLink()
  delete process.env.CLAUDE_CONFIG_DIR
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function harness(launchRun = vi.fn().mockResolvedValue(undefined)) {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    subject: 'alice',
    authed: true,
    authToken: null,
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
  } as unknown as Conn
  const broadcastIntents = vi.fn()
  const ctx = { launchRun, broadcastIntents } as unknown as KernelContext
  return { sent, conn, ctx, launchRun, broadcastIntents }
}

/** A `completed` discussion carrying a conclusion — the only convertible shape. */
function concludedDiscussion(title = 'DISCUSSION_TITLE_ABC', conclusion = 'CONCLUSION_XYZ') {
  const d = createDiscussion({
    workspacePath: proj,
    title,
    type: 'design',
    goal: 'g',
    status: 'completed',
  })
  setConclusion(d.id, conclusion)
  return d
}

function selectedSessionId(sent: ServerToClient[]): string {
  const m = sent.find((x) => x.type === 'session_selected')
  return m && m.type === 'session_selected' ? m.sessionId : ''
}

describe('buildIntentSessionFirstPrompt', () => {
  it('carries the intent preamble, the user input and the exactly-one-id guard', () => {
    const intent = {
      id: 'int-1',
      title: 'Cached endpoint',
      content: 'CONTENT_ABC',
      status: 'draft',
    } as never
    const prompt = buildIntentSessionFirstPrompt(intent, 'USER_INPUT_QRS')
    expect(prompt).toContain('int-1')
    expect(prompt).toContain('CONTENT_ABC')
    expect(prompt).toContain('USER_INPUT_QRS')
    // The in-place-update guard lives here and nowhere else — both call sites
    // (start_intent_session / discussion_to_intent) inherit this wording.
    expect(prompt).toContain('批次必须恰好一项携带 id="int-1"')
    expect(prompt).toContain('拆分出的其他项不得使用该 id')
  })
})

describe('discussion_to_intent', () => {
  it('creates the empty draft intent first, then binds an intent-owned session to it', async () => {
    const d = concludedDiscussion()
    const h = harness()

    await discussionToIntent(h.ctx, h.conn, { type: 'discussion_to_intent', discussionId: d.id })

    // 1) Exactly one intent, identical in shape to the "add intent" placeholder.
    const intents = listIntents(proj)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({
      title: 'new intent',
      content: '',
      priority: 'P2',
      status: 'draft',
    })
    const intentId = intents[0].id

    // 2) The session is bound to that intent in both directions.
    const sid = selectedSessionId(h.sent)
    expect(sid).toBeTruthy()
    expect(getIntent(intentId)?.intentSessionId).toBe(sid)
    expect(takePendingIntentLink(sid)).toBe(intentId)
    // The projected session row carries this intent as owner (not a free-floating
    // comm session), which is what makes it an intent-owned session everywhere.
    expect(listOwnedForWorkspace(proj)).toMatchObject([
      { sessionKind: 'intent', ownerKind: 'intent', ownerId: intentId, vendorSessionId: sid },
    ])

    // 3) The client gets the created intent (so it selects it and pins the
    //    intent-session tab) plus the session, and the run is launched once.
    expect(h.sent.find((m) => m.type === 'create_intent_result')).toMatchObject({
      workspaceId,
      intent: { id: intentId },
    })
    expect(h.conn.viewing).toBe(sid)
    expect(h.launchRun).toHaveBeenCalledTimes(1)

    removeRuntime(sid)
  })

  it('seeds the first turn with the discussion title + conclusion and the shared guard', async () => {
    const d = concludedDiscussion()
    const h = harness()

    await discussionToIntent(h.ctx, h.conn, { type: 'discussion_to_intent', discussionId: d.id })

    const intentId = listIntents(proj)[0].id
    const prompt = h.launchRun.mock.calls[0][1] as string
    expect(prompt).toContain('DISCUSSION_TITLE_ABC')
    expect(prompt).toContain('CONCLUSION_XYZ')
    // Asserted against the shared builder's output for the same intent, so the
    // guard cannot drift away from `start_intent_session`'s copy.
    const created = getIntent(intentId)!
    const guard = buildIntentSessionFirstPrompt(created, 'PROBE').split('PROBE')[1]
    expect(guard).toContain(`id="${intentId}"`)
    expect(prompt).toContain(guard)

    removeRuntime(selectedSessionId(h.sent))
  })

  it.each([
    ['draft', 'CONCLUSION_XYZ'],
    ['in_progress', 'CONCLUSION_XYZ'],
    ['completed', ''],
  ] as const)('refuses a %s discussion without creating anything', async (status, conclusion) => {
    const d = createDiscussion({
      workspacePath: proj,
      title: 'T',
      type: 'design',
      status: status as Discussion['status'],
    })
    if (conclusion) setConclusion(d.id, conclusion)
    const h = harness()

    await discussionToIntent(h.ctx, h.conn, { type: 'discussion_to_intent', discussionId: d.id })

    expect(h.sent).toMatchObject([{ type: 'error', error: { code: 'discussion.notConcludable' } }])
    expect(listIntents(proj)).toEqual([])
    expect(h.launchRun).not.toHaveBeenCalled()
  })

  it('refuses an unknown discussion without creating anything', async () => {
    const h = harness()

    await discussionToIntent(h.ctx, h.conn, { type: 'discussion_to_intent', discussionId: 'nope' })

    expect(h.sent).toMatchObject([{ type: 'error', error: { code: 'discussion.notFound' } }])
    expect(listIntents(proj)).toEqual([])
  })

  it('unwinds the session but keeps the intent when the launch fails', async () => {
    const d = concludedDiscussion()
    const h = harness(vi.fn().mockRejectedValue(new Error('LAUNCH_BOOM')))

    await discussionToIntent(h.ctx, h.conn, { type: 'discussion_to_intent', discussionId: d.id })

    expect(h.sent.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'intent.startSessionFailed' },
    })
    // The intent survives (as on the "add intent" path) with no dangling session.
    const intents = listIntents(proj)
    expect(intents).toHaveLength(1)
    expect(getIntent(intents[0].id)?.intentSessionId).toBeNull()
    expect(takePendingIntentLink(selectedSessionId(h.sent))).toBeUndefined()

    // It stays an asset-free draft, so the ordinary delete path reclaims it.
    await deleteIntent(h.ctx, h.conn, {
      type: 'delete_intent',
      workspaceId,
      intentId: intents[0].id,
    })
    expect(getIntent(intents[0].id)).toBeNull()
  })
})
