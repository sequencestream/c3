/**
 * Discussion and research wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
  Discussion,
  DiscussionMessage,
  DiscussionStatus,
  ResearchMessage,
} from './discussion.js'

/** List a project's discussions (reply: `discussions`), optionally filtered by status. */
export type ClientListDiscussions = {
  type: 'list_discussions'
  workspaceId: string
  status?: DiscussionStatus
}

/**
 * Create a discussion from the "+" form. The server persists it as `draft`
 * (title derived from `goal`), **replies to the creating connection with
 * `discussion_detail`** so the right pane opens the new discussion immediately,
 * and pushes a refreshed `discussions` list. It then runs a read-only research
 * agent that reads project material + searches the web to complete its `context`
 * (pushing `discussions` again); **on success the server auto-starts the
 * orchestration** (equivalent to an automatic `start_discussion`, re-validating
 * the discussion is still a `draft` with no live run). Research failure leaves it
 * a `draft` for a manual Start (the title bar reads "Researching…" until it
 * auto-starts). `type` must name a known discussion type (see `discussion-types.ts`).
 */
export type ClientCreateDiscussion = {
  type: 'create_discussion'
  workspaceId: string
  discussionType: string
  goal: string
  context?: string
  /**
   * The agents selected to participate. Persisted to the discussion; the
   * orchestrator nominates speakers from this set only (the organizer/default
   * agent is always folded in). Defaults all-enabled in the UI, with the
   * organizer entry forced on. An empty/omitted array means the legacy
   * "whole roster" fallback.
   */
  participantAgentIds?: string[]
  /**
   * The agent designated as the organizer. When set, the orchestrator uses
   * this agent instead of the global default. Falls back to the default when
   * absent.
   */
  organizerAgentId?: string
}

/**
 * Open a discussion: enter the discussion view for one discussion and return
 * it together with its full message history. Replies with `discussion_detail`.
 */
export type ClientOpenDiscussion = { type: 'open_discussion'; discussionId: string }

/**
 * Start the organizer-driven orchestration of a `draft` discussion. The server
 * flips it to `in_progress` and runs the engine in the background: the organizer
 * (the default agent) picks speakers among the configured agents and drives the
 * type's workflow (discuss → summarize → confirm → conclude), each turn a
 * one-shot `askAgentOnce` over the current transcript. Every speech is appended
 * and streamed back as `discussion_message`; the run ends by writing the
 * `conclusion` and flipping to `completed`. A no-op if already running or not a
 * `draft`. The background run does not end any session (既有 session 约定).
 */
export type ClientStartDiscussion = { type: 'start_discussion'; discussionId: string }

/**
 * Pause a live discussion orchestration: the engine suspends at the next round
 * boundary, so no new organizer decision or agent speech happens until resumed
 * (an already in-flight one-shot turn may still finish). No-op if the discussion
 * has no live run or is already paused. The frontend reflects it via the
 * `discussion_run_status` (`paused`) event.
 */
export type ClientPauseDiscussion = { type: 'pause_discussion'; discussionId: string }

/**
 * Resume a paused discussion orchestration: the engine continues from where it
 * suspended (its local stage/round state is preserved). No-op if not paused.
 */
export type ClientResumeDiscussion = { type: 'resume_discussion'; discussionId: string }

/**
 * Human interjection into a live discussion ("I want to speak"): the server
 * pauses the run, appends a `human` message, and resumes — so the organizer's
 * next round sees it. Requires a live run (running or paused); when the
 * discussion is `in_progress` without a live run, the message is simply appended.
 */
export type ClientDiscussionSpeak = { type: 'discussion_speak'; discussionId: string; text: string }

/**
 * Drive a *new round* on a `completed` discussion: the server appends the
 * human's follow-up question/intent as a `human` message, flips the
 * discussion back to `in_progress`, and re-runs the organizer engine over the
 * full transcript (the prior conclusion + the new question as context). The run
 * walks the workflow again and writes a fresh `conclusion`. Rejected if the
 * discussion is not `completed` or already has a live run.
 */
export type ClientContinueDiscussion = {
  type: 'continue_discussion'
  discussionId: string
  text: string
}

/**
 * A project's discussion list (reply to `list_discussions`/`open_discussion` entry, or a push
 * after a change). `runStates` is a live snapshot of which listed discussions have an active
 * orchestration run (id → `running`/`paused`) — only active entries are present. It rides every
 * list send (first fetch / reconnect re-fetch / state-change push), so a refresh or reconnect
 * authoritatively reconciles the run-state of background runs (decoupled from persisted `status`).
 */
export type ServerDiscussions = {
  type: 'discussions'
  workspaceId: string
  items: Discussion[]
  runStates?: Record<string, 'running' | 'paused'>
  /**
   * Companion snapshot for the read-only research phase (id → `running`, only discussions
   * with a live research run present). Rides every list send like `runStates`, so a refresh
   * or reconnect mid-research authoritatively rebuilds the research phase (right pane stays on
   * the research stream, Start stays hidden) — the transition-only `research_run_status` is
   * missed by a freshly-(re)connected view.
   */
  researchStates?: Record<string, 'running'>
}

/**
 * One discussion plus its full message history (reply to `open_discussion`).
 * `researchMessages` is the runtime research transcript snapshot: the bounded
 * set of visible research items broadcast so far when the run is live, or empty
 * when no research is in flight. It lets a reconnect/refresh mid-research
 * restore the already-shown research stream (the items themselves are never
 * persisted; later live `research_message` events append by `seq`).
 */
export type ServerDiscussionDetail = {
  type: 'discussion_detail'
  discussion: Discussion
  messages: DiscussionMessage[]
  researchMessages: ResearchMessage[]
}

/**
 * A newly-appended discussion message, pushed live to every connection while
 * the organizer engine runs (the client appends it when viewing that
 * discussion). The companion status/conclusion change rides the refreshed
 * `discussions` list broadcast.
 */
export type ServerDiscussionMessage = {
  type: 'discussion_message'
  discussionId: string
  message: DiscussionMessage
}

/**
 * Live run-state of a discussion's background orchestration, decoupled from its
 * persisted `DiscussionStatus`: `running` / `paused` while the engine is alive,
 * `ended` when the run finishes or is torn down (the frontend then drops its
 * run-state entry and falls back to the persisted status). Runtime-only — not
 * persisted, not restored across a server restart.
 */
export type ServerDiscussionRunStatus = {
  type: 'discussion_run_status'
  discussionId: string
  state: 'running' | 'paused' | 'ended'
}

/**
 * Runtime-only, transient in-flight status of the agents the organizer just
 * dispatched in a round — surfaced in the chat tail so viewers see which agents
 * are replying (and which failed) before anything lands in the transcript.
 * Decoupled from `discussion_message`: never persisted, never an entry in
 * `discussion_messages`, and (unlike `discussion_run_status`) NOT snapshotted on
 * the `discussions` list — it self-heals via `cleared`/`failed`/the reply message
 * /run `ended`/discussion switch, so a refresh or reconnect leaves no stuck pending.
 *
 * - `pending`: `agents` were dispatched and are now replying (a `broadcast` lists
 *   several at once).
 * - `cleared`: `agents` finished (reply appended, or an empty/skipped speech that
 *   produces no `discussion_message`) — drop them from the in-flight set. The
 *   reliable clear for the no-message case; the reply-message path also clears.
 * - `failed`: `agents` (a single agent) failed to reply; `error` is a brief reason.
 *   The discussion continues (the speech is skipped, the round is not blocked).
 */
export type ServerDiscussionDispatchStatus = {
  type: 'discussion_dispatch_status'
  discussionId: string
  phase: 'pending' | 'cleared' | 'failed'
  agents: { id: string; name: string }[]
  error?: string
}

/**
 * A streamed item from a discussion's read-only research run, pushed live while the
 * research agent works (the client appends it to the right pane's research stream when
 * viewing that discussion). Runtime-only, mirrors `discussion_message` but for the
 * research phase; the research transcript is never persisted to the DB, but the server
 * keeps a bounded runtime copy and replays it on the `discussion_detail` snapshot, so a
 * reconnect mid-research restores the already-shown items and de-dupes later live ones
 * by `seq` (the `researchStates` liveness snapshot still drives the research phase).
 */
export type ServerResearchMessage = {
  type: 'research_message'
  discussionId: string
  message: ResearchMessage
}

/**
 * Live run-state of a discussion's read-only research run: `running` while the research
 * agent works, `ended` when it finishes, fails, or its underlying process dies (the run
 * is awaited, so a dead process settles the promise and yields `ended`). Runtime-only —
 * not persisted. On `ended` the frontend drops the research phase; the server then
 * auto-starts the orchestration (emitting `discussion_run_status: running`) on success,
 * or leaves a `draft` for a manual Start on failure.
 */
export type ServerResearchRunStatus = {
  type: 'research_run_status'
  discussionId: string
  state: 'running' | 'ended'
}
