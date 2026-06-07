import type { DiscussionStatus } from '@ccc/shared/protocol'
import type { RunActivity } from './chat-types'

/*
 * status-indicator — the single shared model behind every session/run status
 * indicator, rendered as `<icon> <agent>.<status>` (icon + agent name + dot +
 * status label). Both the SessionStatusBar (Sessions / Intents) and the
 * DiscussionList row build one of these so the icon set, the status→tone map,
 * and the `<agent>.<status>` join stay single-sourced and never drift.
 *
 * Pure & DOM-free: the state→indicator mappers below are unit-tested without a
 * component. The two consumers resolve the i18n text themselves (`statusKey` +
 * `statusParams` → the status segment; `statusIndicator.agentStatus` joins the
 * optional `agent` prefix) and read the glyph from `TONE_ICON[tone]`.
 *
 * `agent` is OPTIONAL: empty/undefined ⇒ the `<agent>.` segment is dropped with
 * no leftover dot/separator (a run with no resolvable agent must never break the
 * indicator — mirrors the old SessionStatusBar empty-agent behavior).
 */

/** Semantic status tone — drives both the icon (`TONE_ICON`) and the color class. */
export type StatusTone =
  | 'running'
  | 'paused'
  | 'awaiting'
  | 'reconnecting'
  | 'error'
  | 'idle'
  | 'draft'
  | 'in_progress'
  | 'completed'
  | 'cancelled'

/**
 * Single source for the status→icon map. Emoji are used to match the app's
 * existing icon idiom (discussion speakers 🤖🙋🔍). Colored circles carry the
 * run/session semantics; lifecycle states get their own distinct glyphs.
 */
export const TONE_ICON: Record<StatusTone, string> = {
  running: '🟢',
  paused: '⏸️',
  awaiting: '🔐',
  reconnecting: '🔄',
  error: '🔴',
  idle: '⚪',
  draft: '📝',
  in_progress: '🔵',
  completed: '✅',
  cancelled: '⛔',
}

/**
 * The finite set of status-label i18n keys the two consumers use. Kept as a
 * narrow union (a subset of `LocaleKey`) so the mappers can return a key the
 * typed `t` accepts directly, while a typo still fails `vue-tsc`.
 */
export type StatusLabelKey =
  | 'session.statusBar.reconnecting'
  | 'session.statusBar.sideEffectPending'
  | 'session.statusBar.error'
  | 'session.statusBar.ready'
  | 'session.statusBar.awaiting'
  | 'session.statusBar.teamRunning'
  | 'session.statusBar.runningTool'
  | 'session.statusBar.thinking'
  | 'discussion.item.run.running.label'
  | 'discussion.item.run.paused.label'
  | 'discussion.status.draft'
  | 'discussion.status.in_progress'
  | 'discussion.status.completed'
  | 'discussion.status.cancelled'

export interface StatusIndicator {
  /** Semantic tone — `TONE_ICON[tone]` is the glyph; also used as a color class. */
  tone: StatusTone
  /** Whether the icon should pulse (active run-class states). */
  spin: boolean
  /** i18n key for the status segment. */
  statusKey: StatusLabelKey
  /** Named params for `statusKey` (e.g. `{ toolName }`, `{ message }`). */
  statusParams?: Record<string, unknown>
  /** Agent name for the `<agent>.` prefix; empty/undefined ⇒ no prefix, no leftover dot. */
  agent?: string
}

/** Normalize an agent name to `undefined` when blank, so callers can branch on truthiness. */
function cleanAgent(name: string | undefined): string | undefined {
  const trimmed = name?.trim()
  return trimmed ? trimmed : undefined
}

export interface SessionStatusInput {
  running: boolean
  teamActive: boolean
  activity: RunActivity
  /** Client-inferred name of the agent the viewed session is running; blank ⇒ no prefix. */
  currentAgentName?: string
  /** Transient running-state hold while backing off before a single auto-resume (AVAIL-7). */
  reconnecting?: boolean
  /** Auto-resume refused by the side-effect gate; awaiting a manual continue (AS-R19). */
  sideEffectPending?: boolean
}

/**
 * SessionStatusBar's state → indicator. Preserves the exact precedence the old
 * `view` computed had: reconnecting > sideEffectPending > error > !running >
 * awaiting > team-idle > tool > thinking. The agent prefix shows whenever a name
 * is present (any state), exactly as the old `agentPrefix` did.
 */
export function sessionStatusIndicator(input: SessionStatusInput): StatusIndicator {
  const agent = cleanAgent(input.currentAgentName)
  const base = { agent }
  if (input.reconnecting) {
    return {
      ...base,
      tone: 'reconnecting',
      spin: true,
      statusKey: 'session.statusBar.reconnecting',
    }
  }
  if (input.sideEffectPending) {
    return {
      ...base,
      tone: 'error',
      spin: false,
      statusKey: 'session.statusBar.sideEffectPending',
    }
  }
  if (input.activity.phase === 'error') {
    return {
      ...base,
      tone: 'error',
      spin: false,
      statusKey: 'session.statusBar.error',
      statusParams: { message: input.activity.message },
    }
  }
  if (!input.running) {
    return { ...base, tone: 'idle', spin: false, statusKey: 'session.statusBar.ready' }
  }
  if (input.activity.phase === 'awaiting') {
    return { ...base, tone: 'awaiting', spin: false, statusKey: 'session.statusBar.awaiting' }
  }
  if (input.teamActive && input.activity.phase === 'idle') {
    return { ...base, tone: 'running', spin: true, statusKey: 'session.statusBar.teamRunning' }
  }
  if (input.activity.phase === 'tool') {
    return {
      ...base,
      tone: 'running',
      spin: true,
      statusKey: 'session.statusBar.runningTool',
      statusParams: { toolName: input.activity.toolName },
    }
  }
  return { ...base, tone: 'running', spin: true, statusKey: 'session.statusBar.thinking' }
}

export interface DiscussionRowInput {
  /** Persisted lifecycle status. */
  status: DiscussionStatus
  /** Live run-state, or undefined when the row has no active run. */
  runState: 'running' | 'paused' | undefined
  /** Name of the in-flight / dispatched agent for the run; blank ⇒ no prefix. */
  agentName?: string
}

const LIFECYCLE: Record<DiscussionStatus, { tone: StatusTone; statusKey: StatusLabelKey }> = {
  draft: { tone: 'draft', statusKey: 'discussion.status.draft' },
  in_progress: { tone: 'in_progress', statusKey: 'discussion.status.in_progress' },
  completed: { tone: 'completed', statusKey: 'discussion.status.completed' },
  cancelled: { tone: 'cancelled', statusKey: 'discussion.status.cancelled' },
}

/**
 * DiscussionList row's state → indicator. A single indicator replacing the old
 * dual (live run badge + lifecycle pill): show the live run-state when present,
 * otherwise fall back to the persisted lifecycle status. The `<agent>` segment
 * is the run's in-flight agent (omitted when unresolvable, and always omitted
 * for the lifecycle fallback — there is no active agent then).
 */
export function discussionRowIndicator(input: DiscussionRowInput): StatusIndicator {
  if (input.runState === 'running') {
    return {
      tone: 'running',
      spin: true,
      statusKey: 'discussion.item.run.running.label',
      agent: cleanAgent(input.agentName),
    }
  }
  if (input.runState === 'paused') {
    return {
      tone: 'paused',
      spin: false,
      statusKey: 'discussion.item.run.paused.label',
      agent: cleanAgent(input.agentName),
    }
  }
  const lc = LIFECYCLE[input.status]
  return { tone: lc.tone, spin: false, statusKey: lc.statusKey }
}
