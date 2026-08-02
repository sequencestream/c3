/**
 * Sessions, runs, transcripts and prompt payloads.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { ModeToken, VendorId } from './vendor.js'

/**
 * Live run state of a session, surfaced to the sidebar so background sessions
 * show their status without being viewed.
 * - `idle` — no turn in flight (session may still be active for the next prompt).
 * - `running` — a turn is executing.
 * - `awaiting_permission` — a turn is blocked waiting on a permission decision.
 * - `team` — a persistent agent-team session: the team lead's process stays alive
 *   between turns, coordinating background teammates. The run is still in-flight
 *   (not idle) even when no turn is actively producing output; it only ends when
 *   the user explicitly stops it.
 * - `reconnecting` — a transient hold: a normal session's turn hit a socket
 *   disconnect and is backing off before a single auto-`resume` of the same run
 *   (AS-R18). The run is still in flight (not idle); it resolves to `running` on
 *   the resume attempt, or to `idle` via `turn_end` if the resume is refused
 *   (side-effect gate) or exhausted.
 */
export type SessionStatus = 'idle' | 'running' | 'awaiting_permission' | 'team' | 'reconnecting'

/** One session's live run status, broadcast to every connection for the sidebar. */
export interface SessionRunStatus {
  sessionId: string
  status: SessionStatus
}

/**
 * The business entities a session can belong to. A session's `(ownerKind,
 * ownerId)` pair is the identity the top-nav badges deduplicate by, so one
 * intent / discussion / automation counts once no matter how many of its
 * sessions run at the same time.
 */
export const SESSION_OWNER_KINDS = ['intent', 'discussion', 'automation'] as const
export type SessionOwnerKind = (typeof SESSION_OWNER_KINDS)[number]

/** A session inside a workspace, as surfaced to the sidebar. */
export interface SessionInfo {
  /**
   * The session's wire id. Work/session list entries are sourced from the
   * `session_metadata` projection; the server resolves this handle back to the
   * owning vendor/native store when reading, resuming, renaming, or deleting.
   */
  sessionId: string
  /** Display title: SDK custom title, summary, or first prompt. */
  title: string
  /** SDK last-modified time, ms since epoch. Sort key within a workspace (desc). */
  lastModified: number
  /**
   * c3-tracked permission mode for this session, as a vendor-native
   * {@link ModeToken} — interpreted against this row's {@link vendor} via that
   * vendor's {@link VendorModeCatalog} (2026-06-07-012; was the Claude-only
   * `PermissionMode`).
   */
  mode: ModeToken
  /** Whether this session was created by a tool (not the user). */
  isToolSession: boolean
  /**
   * The vendor whose native store this session came from (ADR-0013 cross-vendor
   * listing via `SessionAccessor`). A display dimension — drives the sidebar
   * vendor colour dot, cross-vendor filtering, degradation annotation, and the
   * same-vendor candidate filter when switching a session's agent (ADR-0015).
   * The native session *id* is never exposed cross-vendor; only this vendor
   * *tag* is, which the wire already carries elsewhere (`session_selected.vendor`).
   */
  vendor: VendorId
  /**
   * Lifecycle state of the projection row that backs this wire entry
   * (ADR-0013 amendment — `session_metadata` projection). Drives the
   * sidebar's freshness UX: `born`/`alive` are normal list items;
   * `stale` shows a "Unvalidated" tag; `orphaned` grays the row out
   * (the native store has cleared the session); `ghost` shows a
   * "Retry" affordance (the native store errored, so we don't know if
   * the row is real). The web consumer is forward-compatible: an older
   * client that does not know this field simply ignores it.
   */
  state?: 'born' | 'alive' | 'stale' | 'orphaned' | 'ghost'
  /** Business classification carried by the unified `session_metadata` projection. */
  sessionKind?: SessionKind
  /** Owning entity kind used by the frontend jump-back resolver. */
  ownerKind?: SessionOwnerKind | null
  /** Owning entity id used by the frontend jump-back resolver. */
  ownerId?: string | null
  /** `false` only for work pending-bind placeholders; listed rows are normally true. */
  bound?: boolean
}

/**
 * Keyset cursor for a session list slice (SR-R14). The `sessionId` is the
 * stable tiebreaker within one `lastModified` so that sessions sharing a
 * timestamp are never skipped or duplicated across a page boundary — the
 * server locates this exact row in its sorted list and pages from there.
 */
export interface SessionListCursor {
  lastModified: number
  sessionId: string
}

/** How a `sessions` reply should be merged into the client's window (SR-R14). */
export const SESSION_PAGE_KINDS = ['first', 'older', 'window', 'live'] as const
export type SessionPageKind = (typeof SESSION_PAGE_KINDS)[number]

/**
 * Pagination descriptor on a `sessions` reply (SR-R14). Absent only for
 * backward compatibility; the current server always sets it.
 *  - `first`  : top page — client REPLACES the list and resets the window.
 *  - `older`  : next-older page (load-more) — client APPENDS (dedup by id).
 *  - `window` : refresh of the displayed range (`lastModified >= cursor`) —
 *               client reconciles that range (new-at-top in, in-range deletes out).
 *  - `live`   : bounded fan-out push (SR-R13) — client UPSERTs by id without
 *               touching the window (ignored when the workspace isn't loaded).
 * `hasMore` is true when older rows exist beyond a `first`/`older` page;
 * `window`/`live` do not use it.
 */
export interface SessionPageMeta {
  kind: SessionPageKind
  hasMore: boolean
}

/**
 * Title-bar same-vendor agent-switcher payload (ADR-0015 / AS-R22). The console
 * lets the user re-target a stuck session (token-exhausted / rate-limited /
 * host-binary blip) to another agent of the **same** vendor and `resume` it —
 * vendor is frozen, so cross-vendor candidates are never offered. The candidate
 * set is resolved server-side from the **same** same-vendor rule the degradation
 * chain uses (`sameVendorEnabledAgents`), so manual and automatic fallback agree.
 */
export interface SessionAgentSwitch {
  /** The session's current agent (its bound fact, or the default) — the selected option. */
  current: { id: string; displayName: string }
  /** Other same-vendor, host-binary-present, enabled agents (excludes the current). */
  candidates: { id: string; displayName: string }[]
  /** The current agent's host CLI is missing — prompt the user to switch to continue. */
  currentUnavailable: boolean
}

/**
 * One replayed item of a session's historical transcript. Mirrors the live
 * render kinds so the console renders history and live events the same way.
 */
export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  /**
   * A turn that produced no visible output — the model only thought (an
   * end_turn after a thinking-only response) and emitted no assistant text or
   * tool call. Without this, the turn would render as nothing at all, which is
   * indistinguishable from a silent hang. Surfaced as a muted system line.
   */
  | { kind: 'notice'; text: string }

/** Display text for a turn that ended with only thinking and no visible output. */
export const EMPTY_TURN_NOTICE = '— No response this turn (the model only thought) —'

/**
 * The media types c3 accepts for prompt images — the ONLY file kind a user
 * message may carry to an agent (2026-06-16). Both vendor adapters can ingest
 * these: Claude as a base64 `image` content block, Codex as a `local_image`
 * path. Any other `mediaType` is rejected at the server boundary (the non-goal
 * is generic file/attachment support).
 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

/**
 * An image attached to a {@link ClientToServer} `user_prompt`. `data` is the
 * raw base64-encoded image bytes WITHOUT a `data:` URI prefix (the caller strips
 * it); `mediaType` is one of {@link IMAGE_MEDIA_TYPES}. The neutral shape both
 * adapters consume — the boundary guard `isImageMediaType` lives in `image-media.ts`.
 */
export interface PromptImage {
  mediaType: string
  data: string
}

/**
 * A not-yet-started session. The browser invents the `clientId`; the server
 * binds it to a real SDK `sessionId` (via `session_started`) once the first
 * prompt's `query()` reports one.
 */
export const PENDING_SESSION_PREFIX = 'pending:'

/**
 * One available slash command / skill for the input-box autocomplete menu.
 * Mirrors the SDK `SlashCommand` shape but is declared here to keep the wire
 * protocol independent of SDK types (the boundary rule). Covers both built-in
 * commands and Skills (user + project), exactly what the CLI lists on `/`.
 */
export interface SlashCommandInfo {
  /** Command/skill name without the leading slash. */
  name: string
  /** What the command/skill does. */
  description: string
  /** Hint for arguments, e.g. "<file>" (may be empty). */
  argumentHint: string
  /** Alternate names that resolve to this command (e.g. /cost → /usage). */
  aliases?: string[]
}

/**
 * **Business-scenario** taxonomy: WHICH agent-invocation scenario produced an
 * event or drives a runtime. One value per distinct business origin so listeners
 * route by source. This is the source-of-truth dimension for "where did this come
 * from" — orthogonal to {@link RunKind}, which says "how was it executed".
 *
 * - `work`        — a general work session: the user console, an
 *   intent→development hand-off, and the automation dev-turn. (Was `'session'`,
 *   itself once the pre-2026-06-08 `'normal'`.)
 * - `intent`      — a read-only intent-communication session (the intent gate +
 *   disallowed-tools lock).
 * - `discussion`  — the discussion orchestrator and its research pass.
 * - `automation`    — the scheduler's own **socket-less run** (e.g. an `llm`
 *   scheduled task). NOTE: `automation` identifies the *trigger source*, NOT a
 *   scenario a work session morphs into — a automation-*triggered* target session run
 *   is still `work`. `automation` only tags the scheduler's own run.
 * - `consensus`   — a consensus vote (each voter is a tool-free one-shot).
 * - `tool`        — an internal tool call: completion judging (judge) and title
 *   derivation.
 * - `spec`        — a spec-authoring session: writes confined to the intent's
 *   spec directory (path-level write gate), the project read-only elsewhere.
 * - `spec_review` — a spec-REVIEW session: strictly read-only. It reads the spec,
 *   the repository source and this project's intents, and reports its verdict
 *   through one narrow submit tool. It deliberately does NOT reuse `spec`, which
 *   would silently grant the spec directory's write permission — a reviewer never
 *   edits the document it reviews.
 *
 * Migration (2026-06-26): split out of the old `RunKind`, whose 7 business values
 * moved here verbatim with `'session' → 'work'`. Business-source judgements (which
 * scenario may trigger a automation, which security gate applies) read `sessionKind`.
 */
export type SessionKind =
  'work' | 'intent' | 'discussion' | 'automation' | 'consensus' | 'tool' | 'spec' | 'spec_review'

/**
 * All {@link SessionKind} values, for runtime validation and UI iteration (kept in
 * sync with the `SessionKind` union above). A `satisfies` guard makes a drift a
 * compile error.
 */
export const SESSION_KINDS = [
  'work',
  'intent',
  'discussion',
  'automation',
  'consensus',
  'tool',
  'spec',
  'spec_review',
] as const satisfies readonly SessionKind[]

/**
 * **Execution-form** taxonomy: HOW a run executes, independent of its business
 * scenario ({@link SessionKind}). Two runs of the same `sessionKind` can differ
 * here — e.g. a `work` user console is `interactive` (socket-backed) while a
 * `work` automation dev-turn is `background` (no socket, still on the run bus).
 *
 * - `interactive` — a socket-backed run a human is actively watching (user
 *   console, intent→dev hand-off, intent/spec communication sessions).
 * - `background`  — a socket-less run that still flows through the run bus (the
 *   automation dev-turn).
 * - `headless`    — the scheduler's own socket-less run.
 * - `internal`    — an internal orchestration/tool invocation (discussion,
 *   consensus, judge/naming tool calls).
 *
 * Migration (2026-06-26): narrowed out of the old `RunKind`, whose 7 business
 * values moved to {@link SessionKind}. Execution-mechanism judgements read
 * `runKind`. Currently `runKind` has audit/record readers but no consumer branch;
 * it is laid down so a future agent scenario already carries its execution form.
 */
export type RunKind = 'interactive' | 'background' | 'headless' | 'internal'
