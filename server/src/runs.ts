/**
 * Session-runtime registry — the core of multi-session concurrency.
 *
 * A `SessionRuntime` owns everything about one session's *execution*, decoupled
 * from any WebSocket connection's *view*:
 *   - the in-flight run (abort + live handle), if a turn is executing;
 *   - a `baseline` snapshot of the on-disk transcript captured when the runtime
 *     was first created, plus a `buffer` of every wire event emitted since — so
 *     a connection switching back replays `baseline + buffer` and sees the full
 *     record, with no disk/live double-counting (disk is read exactly once per
 *     session per process);
 *   - the set of `viewers` (per-connection deliver callbacks) currently looking
 *     at this session, so live events fan out only to who is watching it.
 *
 * The registry is module-level (shared across connections) so runs survive a
 * connection switching away, the browser refreshing, or every tab closing — the
 * run keeps going in the background until it finishes or is explicitly stopped.
 *
 * Status changes (idle / running / awaiting_permission) trigger a single global
 * `onStatusChange` callback; the server broadcasts the new statuses to every
 * connection so sidebars can badge background sessions.
 */
import type {
  PermissionMode,
  ServerToClient,
  SessionRunStatus,
  SessionStatus,
  TranscriptItem,
} from '@ccc/shared/protocol'
import type { RunHandle } from './kernel/agent/index.js'

export type Viewer = (event: ServerToClient) => void

interface InFlightRun {
  abort: AbortController
  handle: RunHandle | null
}

/**
 * What kind of session a runtime drives:
 * - `normal` — an ordinary user session (default).
 * - `intent` — a read-only intent-communication session; runs with the
 *   intent permission gate + disallowed-tools lock and is hidden from the
 *   normal session list.
 */
export type SessionKind = 'normal' | 'intent'

export interface SessionRuntime {
  /** Real SDK id, or a `pending:…` id until the first run binds it. */
  sessionId: string
  workspacePath: string
  mode: PermissionMode
  /** Normal user session vs. read-only intent-communication session. */
  kind: SessionKind
  /** On-disk transcript snapshot at runtime creation; replayed before `buffer`. */
  baseline: TranscriptItem[]
  /** Every wire event emitted since creation, across all turns. */
  buffer: ServerToClient[]
  /** Non-null while a turn is executing. */
  run: InFlightRun | null
  /**
   * True once this run is detected to be a persistent agent team (a team tool was
   * used). The lead process then stays alive across turns, so `turn_end` keeps the
   * status at `team` (not `idle`) and the next user prompt is fed into the live
   * run instead of resuming a fresh process. Reset when the run tears down.
   */
  team: boolean
  status: SessionStatus
  /**
   * Request ids of permission prompts that have been emitted but not yet decided
   * (answered/denied by the human). While this set is non-empty AND the run is
   * still alive, a stray `turn_end` must NOT collapse the session to `idle` — the
   * answer panel would otherwise downgrade to a static history line and become
   * unanswerable (the consensus-window race). Cleared per-request when the human
   * answers (`resolvePending`) and wholesale on teardown (`clearPending`).
   */
  pending: Set<string>
  /**
   * Whether a terminal `turn_end` has already been broadcast for the current
   * turn. Set in `emit` when a `turn_end` flows through; reset in `setStatus`
   * when a new turn starts (status → `running`). `finalizeRun` reads it to avoid
   * emitting a duplicate `turn_end` while still guaranteeing exactly one fires —
   * the authoritative terminal-state backstop (see `finalizeRun`).
   */
  sawTurnEnd: boolean
  /**
   * ms since epoch of the most recent activity in this session (any `emit` call
   * or runtime creation). Used by the session-layer heartbeat to detect stale /
   * hung runs: if the status is `running` but no event has been emitted for more
   * than `staleMs`, the run is presumed hung and gets forcefully converged to
   * `idle`. Updated in `emit()`.
   */
  lastActivityAt: number
  viewers: Set<Viewer>
}

const runtimes = new Map<string, SessionRuntime>()

let onStatusChange: (() => void) | null = null
/** Register the global status-change listener (the server broadcasts statuses). */
export function setOnStatusChange(cb: (() => void) | null): void {
  onStatusChange = cb
}

/**
 * Optional per-event observer, called for every emitted wire event AFTER it has
 * been buffered + fanned out. Registered at the composition root (kept out of
 * runs.ts so the registry never imports task semantics — same shape as
 * `onStatusChange`/`onRunEnd`). 2026-06-07-009 wires it to the task-list
 * derivation (`observeTaskWire`): it may itself call `emit()` (e.g. to push a
 * `task_list`), which is safe — the re-entrant event is buffered/fanned normally
 * and the observer is a no-op for it.
 */
let taskObserver: ((rt: SessionRuntime, event: ServerToClient) => void) | null = null
/** Register the wire-event observer (composition root only). */
export function setTaskObserver(
  cb: ((rt: SessionRuntime, event: ServerToClient) => void) | null,
): void {
  taskObserver = cb
}

export function getRuntime(id: string): SessionRuntime | undefined {
  return runtimes.get(id)
}

/**
 * Return the runtime for `id`, creating it (seeded with `baseline`) if absent.
 * `baseline` is only used on creation — an existing runtime keeps its own.
 */
export function ensureRuntime(
  id: string,
  workspacePath: string,
  mode: PermissionMode,
  baseline: TranscriptItem[],
  kind: SessionKind = 'normal',
): SessionRuntime {
  let rt = runtimes.get(id)
  if (!rt) {
    rt = {
      sessionId: id,
      workspacePath,
      mode,
      kind,
      baseline,
      buffer: [],
      run: null,
      team: false,
      status: 'idle',
      pending: new Set(),
      sawTurnEnd: false,
      lastActivityAt: Date.now(),
      viewers: new Set(),
    }
    runtimes.set(id, rt)
  }
  return rt
}

/** Status implied by a wire event, or null if the event doesn't change status. */
function statusFor(event: ServerToClient): SessionStatus | null {
  switch (event.type) {
    case 'permission_request':
      return 'awaiting_permission'
    case 'turn_end':
      return 'idle'
    case 'assistant_text':
    case 'tool_use':
    case 'tool_result':
    case 'consensus_auto':
      return 'running'
    default:
      return null
  }
}

/**
 * Record a wire event for a session: append to its buffer, fan out to current
 * viewers, and advance its status (broadcasting if it changed). No-op if the
 * runtime is gone (e.g. deleted mid-run).
 */
export function emit(id: string, event: ServerToClient): void {
  const rt = runtimes.get(id)
  if (!rt) return
  rt.buffer.push(event)
  rt.lastActivityAt = Date.now()
  for (const viewer of rt.viewers) viewer(event)
  // Track outstanding (un-decided) permission prompts so the guard below can keep
  // a genuinely-blocked, still-alive run from collapsing to idle.
  if (event.type === 'permission_request') rt.pending.add(event.requestId)
  // Note that this turn has broadcast its terminal event, so `finalizeRun` won't
  // synthesize a duplicate. Set on the raw event regardless of the status guards
  // below (the wire event reached viewers either way).
  if (event.type === 'turn_end') rt.sawTurnEnd = true
  let next = statusFor(event)
  // A `turn_end` (→ idle) must NOT drop a live run that still has an un-answered
  // permission prompt: that would flip the session out of `awaiting_permission`,
  // null out the front-end's `actionablePermissionId`, and downgrade the answer
  // panel to a static "曾请求…" line — the consensus-window race. While the run is
  // alive (`rt.run != null`) and a prompt is pending, hold at `awaiting_permission`
  // so the panel stays actionable until the human answers. Once the run is torn
  // down (`rt.run` null) idle is correct — the request can no longer be answered.
  // This takes precedence over the team-hold (an unanswered prompt outranks "team
  // lead idle between turns").
  if (next === 'idle' && rt.run != null && rt.pending.size > 0) {
    next = 'awaiting_permission'
  } else if (next === 'idle' && rt.team) {
    // A team lead's process stays alive between turns: a `turn_end` means "this
    // lead turn finished", not "idle". Hold the status at `team` so the sidebar and
    // composer treat it as a live, persistent session awaiting teammates.
    next = 'team'
  } else if (next === 'idle' && rt.run != null) {
    // The normal `result` path emits this `turn_end` from *inside* `runClaude`, so
    // the run's teardown `finally` (which nulls `rt.run`) hasn't run yet. Settling
    // to idle now would broadcast `idle` while `rt.run` is still set — the client
    // sees the idle transition, flushes its pending-send queue as a fresh
    // `user_prompt`, and the server rejects it with "a turn is already running",
    // silently dropping the queued prompt. Hold the current status instead;
    // `finalizeRun` re-settles to idle AFTER the `finally` nulls `rt.run`, so the
    // flushed prompt lands on a session that is genuinely ready to accept it.
    next = null
  }
  if (next && next !== rt.status) {
    rt.status = next
    onStatusChange?.()
  }
  // Derive side-channel wire events (task list) from this event. Runs last, after
  // buffering/fan-out/status, so any event it re-emits (e.g. `task_list`) is
  // ordered right after the event that produced it. Re-entry is a no-op.
  taskObserver?.(rt, event)
}

/**
 * Mark one permission prompt decided (the human answered/denied it) so it no
 * longer holds the session in `awaiting_permission`. Request ids are globally
 * unique, so this scans every runtime — the answering connection need not know
 * which session owns the prompt.
 */
export function resolvePending(requestId: string): void {
  for (const rt of runtimes.values()) {
    if (rt.pending.delete(requestId)) return
  }
}

/** Drop every outstanding permission prompt for a session (run teardown). */
export function clearPending(id: string): void {
  runtimes.get(id)?.pending.clear()
}

/** Force a runtime's status (e.g. 'running' at run start). Broadcasts if changed. */
export function setStatus(id: string, status: SessionStatus): void {
  const rt = runtimes.get(id)
  if (!rt) return
  // A new turn starts when the server forces `running`: arm the terminal-state
  // backstop so this turn must broadcast (or have `finalizeRun` synthesize) its
  // own `turn_end`, independent of the previous turn.
  if (status === 'running') rt.sawTurnEnd = false
  if (rt.status === status) return
  rt.status = status
  onStatusChange?.()
}

/**
 * Authoritative terminal-state backstop: the run is over (the caller has torn it
 * down in its `finally`). If no terminal `turn_end` was broadcast this turn — the
 * SDK iterator ended or the Claude process exited without a clean `result`, so the
 * run loop never emitted one — synthesize a `turn_end` now, then unconditionally
 * settle to `idle`. This is what frees a viewer that would otherwise stay stuck
 * "thinking" forever (and, on the client, releases the pending-send queue). The
 * `sawTurnEnd` flag keeps this idempotent: a run that already emitted `turn_end`
 * (the normal `result` path) only gets the `setStatus(idle)`, never a duplicate.
 *
 * Note: a process that truly *hangs* (the `for await` never returns, so the run's
 * `finally` never runs) is out of scope here — that path is still settled by the
 * user pressing Stop (abort), which closes the input and reaches this teardown.
 */
export function finalizeRun(id: string): void {
  const rt = runtimes.get(id)
  if (!rt) return
  if (!rt.sawTurnEnd) emit(id, { type: 'turn_end', reason: 'complete' })
  setStatus(id, 'idle')
  // Run-end projection upsert: the first user-prompt text is the new
  // `title` (matches the legacy `titleOf` fallback). `lastModified` is
  // left to the next lazy validation; the SDK mtime isn't surfaced here
  // without a synchronous native read.
  onRunEnd?.({ realId: id, title: firstUserTitle(rt.baseline) })
}

export function addViewer(id: string, viewer: Viewer): void {
  runtimes.get(id)?.viewers.add(viewer)
}

export function removeViewer(id: string, viewer: Viewer): void {
  runtimes.get(id)?.viewers.delete(viewer)
}

// ---- Run-end hook (composition-time, for the projection table) ----
//
// `finalizeRun` is the single terminal-state backstop (called from BOTH run
// paths' teardown). The kernel can't import the projection store directly
// (kernel ↛ features boundary, ADR-0009), so the actual write happens via
// this registered callback. The composition root wires it to
// `touchOnRunEnd` in `features/sessions/store.ts`.

export interface OnRunEndInput {
  realId: string
  /** First user-prompt text, when available — the projection's title source. */
  title: string
}

let onRunEnd: ((input: OnRunEndInput) => void) | null = null

/** Register the run-end hook (composition root only). */
export function setOnRunEnd(cb: ((input: OnRunEndInput) => void) | null): void {
  onRunEnd = cb
}

/**
 * Best-effort title for a real session: the first user-prompt text from
 * the runtime's baseline. Matches the legacy `listWorkspaceSessions`'s
 * `titleOf` fallback (`customTitle || summary || firstPrompt` — the
 * `firstPrompt` is the first user message in the SDK transcript). Returns
 * `'New session'` when no baseline entry is available yet.
 */
function firstUserTitle(baseline: TranscriptItem[]): string {
  for (const item of baseline) {
    if (item.kind === 'user') {
      const t = item.text?.trim()
      if (t) return t
    }
  }
  return 'New session'
}

/**
 * Re-key a pending runtime to its real SDK id once the first run reports one.
 * Viewers, buffer, baseline, and the in-flight run all move with it. If a
 * runtime already exists under `realId` (shouldn't normally happen), the pending
 * one is dropped in its favor.
 */
export function bindPending(pendingId: string, realId: string): void {
  if (pendingId === realId) return
  const rt = runtimes.get(pendingId)
  if (!rt) return
  runtimes.delete(pendingId)
  if (!runtimes.has(realId)) {
    rt.sessionId = realId
    runtimes.set(realId, rt)
  }
}

/** Abort the in-flight run of a session, if any. The run's teardown clears it. */
export function stopRun(id: string): void {
  runtimes.get(id)?.run?.abort.abort()
}

/** Abort any run and drop the runtime entirely (session deleted / workspace removed). */
export function removeRuntime(id: string): void {
  const rt = runtimes.get(id)
  if (!rt) return
  rt.run?.abort.abort()
  runtimes.delete(id)
}

export function isRunning(id: string): boolean {
  return runtimes.get(id)?.run != null
}

/** All known sessions' live statuses, for the handshake and broadcasts. */
export function listStatuses(): SessionRunStatus[] {
  return [...runtimes.values()].map((rt) => ({ sessionId: rt.sessionId, status: rt.status }))
}

/**
 * Session-layer liveness reconciliation: identify stale/hung runs and converge
 * them to `idle`. Called periodically by the server's status heartbeat.
 *
 * A run is converged when:
 * 1. Its AbortController has already been triggered (`aborted === true`) but
 *    the teardown `finally` never ran — the run is stuck in a zombie state.
 *    This applies to ALL statuses including `awaiting_permission` and `team`.
 * 2. The status is `running` AND no event has been emitted for > `staleMs` —
 *    the SDK iterator or for-await loop is presumed hung / the process exited
 *    without a clean result.
 *
 * `awaiting_permission` and `team` runs are NOT converged by staleness alone
 * (a user waiting on a prompt is legitimate; a team lead waiting between turns
 * is legitimate). Only the `aborted` branch covers them.
 *
 * Convergence mimics `launchRun`'s teardown `finally`: abort the controller,
 * clear the run pointer, reset team flag, drop pending prompts, and `finalizeRun`.
 *
 * @returns The session ids that were converged (for testing).
 */
export function reconcileLiveness(now: number, staleMs: number): string[] {
  const converged: string[] = []
  for (const [id, rt] of runtimes) {
    if (!rt.run) continue
    // Branch 1: run was already aborted but hasn't cleaned up.
    if (rt.run.abort.signal.aborted) {
      rt.run = null
      rt.team = false
      clearPending(id)
      finalizeRun(id)
      converged.push(id)
      continue
    }
    // Branch 2: status running with no recent activity → presumed hung.
    if (rt.status === 'running' && now - rt.lastActivityAt > staleMs) {
      rt.run.abort.abort()
      rt.run = null
      rt.team = false
      clearPending(id)
      finalizeRun(id)
      converged.push(id)
      continue
    }
    // Branch 3: status/run inconsistency — a live run pointer but the status has
    // settled to `idle` (e.g. a stray `turn_end` flowed through `emit` before the
    // run's teardown cleared `rt.run`). Broadcasts would then advertise the session
    // as idle while `user_prompt` still rejects with "a turn is already running",
    // and the staleness branch above (gated on `running`) never reaps it. Force a
    // consistent terminal state so the client and server agree.
    if (rt.status === 'idle') {
      rt.run.abort.abort()
      rt.run = null
      rt.team = false
      clearPending(id)
      finalizeRun(id)
      converged.push(id)
      continue
    }
    // `awaiting_permission` and `team` are not converged by staleness alone.
  }
  return converged
}

/** Abort and drop every runtime under `workspacePath` (workspace removed). */
export function removeRuntimesForWorkspace(workspacePath: string): void {
  for (const [id, rt] of runtimes) {
    if (rt.workspacePath === workspacePath) {
      rt.run?.abort.abort()
      runtimes.delete(id)
    }
  }
}
