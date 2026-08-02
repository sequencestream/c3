/**
 * Discussions and research messages.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

// ---- Discussion ----

/**
 * Discussion lifecycle status.
 * - `draft` — created, not yet started.
 * - `in_progress` — discussion underway.
 * - `completed` — concluded; stamps `completedAt`.
 * - `cancelled` — abandoned (terminal, no completion stamp).
 */
export type DiscussionStatus = 'draft' | 'in_progress' | 'completed' | 'cancelled'

/**
 * Who authored a discussion message.
 * - `organizer` — the discussion organizer/orchestrator.
 * - `agent` — a participating agent (identified by `speakerAgentId`/`speakerName`).
 * - `human` — the user.
 */
export type DiscussionSpeakerKind = 'organizer' | 'agent' | 'human'

/** One persisted discussion, scoped to a project (workspace path). */
export interface Discussion {
  /** Stable uuid. */
  id: string
  /** Owning project — the workspace absolute path (resolved). */
  workspaceId: string
  title: string
  /** Free-form discussion type/category. */
  type: string
  /** What the discussion aims to achieve. */
  goal: string
  /** Background material seeding the discussion — the user's original input, never overwritten. */
  context: string
  /**
   * The read-only research agent's completed output, stored independently of the user's
   * `context` (which stays as entered). `''` until research produces a non-empty result
   * (or when research is skipped/fails).
   */
  researchResult: string
  /**
   * The research run's own vendor session id — the research pass is a first-class
   * session, not a one-shot: its transcript lives in the vendor store, it is listed
   * on the sessions page under the `discussion` category, and a follow-up prompt on
   * it resumes the research and rewrites {@link researchResult}. Absent for every
   * discussion created before the research run owned a session identity, and for a
   * run that died before the vendor reported an id.
   */
  researchSessionId?: string
  status: DiscussionStatus
  /**
   * Ordered subtopics the organizer decomposed `goal` into (the explicit agenda).
   * `[]` when no agenda has been set. Only meaningful in the `discuss` stage.
   */
  agenda: string[]
  /**
   * 0-based index of the current subtopic within `agenda` (range `0..agenda.length`).
   * Items before it are done; `agendaIndex === agenda.length` means all subtopics
   * are complete. Completion status is derived from this index (strictly forward).
   */
  agendaIndex: number
  /**
   * The agent ids selected at creation to participate — the orchestrator nominates
   * speakers from this set only (the organizer is always included even when absent
   * here). `[]` means "unset" (legacy rows / pre-selection discussions) and the
   * orchestrator falls back to the whole `enabledAgents()` roster for back-compat.
   */
  participantAgentIds: string[]
  /**
   * The agent id designated as the organizer for this discussion. When set, the
   * orchestrator uses this agent instead of the global default. Falls back to
   * the default agent when unset or when the referenced agent no longer exists.
   */
  organizerAgentId: string | null
  /** The concluded outcome; `null` until set. */
  conclusion: string | null
  /**
   * Free-form business annotations the MCP `start_discussion` caller attached to
   * this discussion (flat `string → string`, same hygiene bounds as automation
   * metadata). `{}` when never supplied — including every legacy row and every
   * Web-UI-started discussion. Carried on the discussion lifecycle events so an
   * automation can filter on the caller's own context.
   */
  metadata: Record<string, string>
  createdAt: number
  updatedAt: number
  /** When the discussion entered `completed`; `null` otherwise. */
  completedAt: number | null
}

/** One message within a discussion, ordered by `seq` (per-discussion monotonic). */
export interface DiscussionMessage {
  /** Stable uuid. */
  id: string
  /** The owning discussion's id. */
  discussionId: string
  /** Per-discussion monotonic sequence number (1-based, assigned on append). */
  seq: number
  speakerKind: DiscussionSpeakerKind
  /** The participating agent's id when `speakerKind === 'agent'`; else `null`. */
  speakerAgentId: string | null
  /** Display name of the speaker; `null` when not applicable. */
  speakerName: string | null
  content: string
  createdAt: number
}

/**
 * Fields common to every {@link ResearchMessage} variant. `seq` is monotonic
 * (1-based) within a single research run; `createdAt` is a server stamp (the UI
 * does not read it — research items carry no timestamp surface).
 */
export interface ResearchMessageMeta {
  discussionId: string
  seq: number
  createdAt: number
}

/**
 * The variant payload of a research item, mirroring the agent stream so the right
 * pane renders the same standard transcript as a work/intent session: a `text`
 * turn is the researcher's assistant text; a `tool_use` carries the call's
 * id/name/input; a `tool_result` carries the same call's returned content + error
 * flag, correlated by `toolUseId`. Factored out so the server's pre-stamp stream
 * item and the wire `ResearchMessage` share one discriminated union (and so
 * `Omit`-style derivations don't collapse the union to its common keys).
 */
export type ResearchMessageBody =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }

/**
 * One streamed item from a discussion's read-only research run. Runtime-only —
 * NOT persisted (unlike `DiscussionMessage`). Unlike `discussion_dispatch_status`,
 * the server keeps a bounded runtime transcript of the run's visible items and
 * replays it on the `discussion_detail` snapshot, so a reconnect mid-research
 * restores what was already shown; later live items append by `seq`.
 */
export type ResearchMessage = ResearchMessageMeta & ResearchMessageBody
