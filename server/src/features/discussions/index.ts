/**
 * `discussions` feature handlers — slice 1/3 (ADR-0009).
 *
 * Discussion list/detail + the orchestration lifecycle (start/pause/resume/
 * speak/continue). Live run controls live in `discussions/run-controls` (feature-
 * private); the run starters live on `ctx`; per-connection delivery on `conn`.
 */
import { resolve } from 'node:path'
import {
  appendMessage as appendDiscussionMessage,
  createDiscussion,
  getDiscussion,
  isStoreAvailable as isDiscussionStoreAvailable,
  listDiscussions,
  listMessages as listDiscussionMessages,
  updateDiscussionStatus,
} from './store.js'
import { isDiscussionType } from '@ccc/shared/discussion-types'
import { discussionRunSnapshot, getDiscussionRun, hasDiscussionRun } from './run-controls.js'
import type { Handler } from '../../transport/handler-registry.js'

export const listDiscussionsHandler: Handler<'list_discussions'> = (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!isDiscussionStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'discussion.dbUnavailable' } })
    return
  }
  const discItems = listDiscussions(proj, msg.status)
  conn.send({
    type: 'discussions',
    projectPath: proj,
    items: discItems,
    runStates: discussionRunSnapshot(discItems),
  })
}

export const createDiscussionHandler: Handler<'create_discussion'> = (ctx, conn, msg) => {
  if (!isDiscussionStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'discussion.dbUnavailable' } })
    return
  }
  if (!isDiscussionType(msg.discussionType)) {
    conn.send({
      type: 'error',
      error: { code: 'discussion.unknownType', params: { type: msg.discussionType } },
    })
    return
  }
  const proj = resolve(msg.projectPath)
  // Title is derived from the goal (the form has no title field): first
  // non-empty line, trimmed and capped.
  const firstLine =
    msg.goal
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const title = (firstLine || 'Discussion').slice(0, 80)
  const created = createDiscussion({
    projectPath: proj,
    title,
    type: msg.discussionType,
    goal: msg.goal,
    context: msg.context ?? '',
    status: 'draft',
  })
  // Open the new discussion on the creating connection right away (so the right
  // pane shows it without a manual click) and push the draft to every
  // connection's list. Then run the read-only research agent in the background
  // to complete its context; when it succeeds we auto-start the orchestration
  // (equivalent to an auto `start_discussion`). Fire-and-forget: research never
  // blocks creation.
  conn.send({ type: 'discussion_detail', discussion: created, messages: [] })
  ctx.broadcastDiscussions(proj)
  // Run the read-only research agent as an observable run: it streams its turns
  // to the right pane and broadcasts its liveness, then auto-starts the
  // orchestration on success (see startResearchRun).
  ctx.startResearchRun(created)
}

export const openDiscussion: Handler<'open_discussion'> = (_ctx, conn, msg) => {
  if (!isDiscussionStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'discussion.dbUnavailable' } })
    return
  }
  const discussion = getDiscussion(msg.discussionId)
  if (!discussion) {
    conn.send({
      type: 'error',
      error: { code: 'discussion.unknown', params: { id: msg.discussionId } },
    })
    return
  }
  conn.send({
    type: 'discussion_detail',
    discussion,
    messages: listDiscussionMessages(msg.discussionId),
  })
}

export const startDiscussion: Handler<'start_discussion'> = (ctx, conn, msg) => {
  if (!isDiscussionStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'discussion.dbUnavailable' } })
    return
  }
  const discussion = getDiscussion(msg.discussionId)
  if (!discussion) {
    conn.send({
      type: 'error',
      error: { code: 'discussion.unknown', params: { id: msg.discussionId } },
    })
    return
  }
  // Idempotent guards: only a `draft` can be started, and never twice.
  if (hasDiscussionRun(discussion.id)) return
  if (discussion.status !== 'draft') {
    conn.send({ type: 'error', error: { code: 'discussion.alreadyStarted' } })
    return
  }
  ctx.startDiscussionRun(discussion)
}

export const pauseDiscussion: Handler<'pause_discussion'> = (ctx, _conn, msg) => {
  const ctrl = getDiscussionRun(msg.discussionId)
  if (!ctrl || ctrl.paused) return
  ctrl.paused = true
  ctx.broadcastDiscussionRunStatus(msg.discussionId, 'paused')
}

export const resumeDiscussion: Handler<'resume_discussion'> = (ctx, _conn, msg) => {
  const ctrl = getDiscussionRun(msg.discussionId)
  if (!ctrl || !ctrl.paused) return
  ctrl.paused = false
  const waiters = ctrl.resumeWaiters.splice(0)
  for (const wake of waiters) wake()
  ctx.broadcastDiscussionRunStatus(msg.discussionId, 'running')
}

export const discussionSpeak: Handler<'discussion_speak'> = (ctx, conn, msg) => {
  if (!isDiscussionStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'discussion.dbUnavailable' } })
    return
  }
  const discussion = getDiscussion(msg.discussionId)
  if (!discussion) {
    conn.send({
      type: 'error',
      error: { code: 'discussion.unknown', params: { id: msg.discussionId } },
    })
    return
  }
  const text = msg.text.trim()
  if (!text) return
  // Pause the live run (if any) so the human message lands at a round boundary,
  // append + stream it, then resume — the organizer's next round picks it up
  // from the transcript.
  const ctrl = getDiscussionRun(msg.discussionId)
  if (ctrl) {
    ctrl.paused = true
    ctx.broadcastDiscussionRunStatus(msg.discussionId, 'paused')
  }
  const message = appendDiscussionMessage({
    discussionId: msg.discussionId,
    speakerKind: 'human',
    speakerName: 'Human',
    content: text,
  })
  ctx.broadcastDiscussionMessage(msg.discussionId, message)
  if (ctrl) {
    ctrl.paused = false
    const waiters = ctrl.resumeWaiters.splice(0)
    for (const wake of waiters) wake()
    ctx.broadcastDiscussionRunStatus(msg.discussionId, 'running')
  }
}

export const continueDiscussion: Handler<'continue_discussion'> = (ctx, conn, msg) => {
  if (!isDiscussionStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'discussion.dbUnavailable' } })
    return
  }
  const discussion = getDiscussion(msg.discussionId)
  if (!discussion) {
    conn.send({
      type: 'error',
      error: { code: 'discussion.unknown', params: { id: msg.discussionId } },
    })
    return
  }
  // Re-entry guard + only a concluded discussion can start a new round.
  if (hasDiscussionRun(discussion.id)) return
  if (discussion.status !== 'completed') {
    conn.send({ type: 'error', error: { code: 'discussion.notEndedForContinue' } })
    return
  }
  const text = msg.text.trim()
  if (!text) return
  // Append the human's follow-up, flip back to in_progress, and re-run the
  // engine over the full transcript (prior conclusion + new question).
  const message = appendDiscussionMessage({
    discussionId: discussion.id,
    speakerKind: 'human',
    speakerName: 'Human',
    content: text,
  })
  ctx.broadcastDiscussionMessage(discussion.id, message)
  updateDiscussionStatus(discussion.id, 'in_progress')
  ctx.broadcastDiscussions(discussion.projectPath)
  ctx.startDiscussionRun({ ...discussion, status: 'in_progress' })
}
