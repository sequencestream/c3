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
import type { RunHandle } from './claude.js'

export type Viewer = (event: ServerToClient) => void

interface InFlightRun {
  abort: AbortController
  handle: RunHandle | null
}

/**
 * What kind of session a runtime drives:
 * - `normal` — an ordinary user session (default).
 * - `requirement` — a read-only requirement-communication session; runs with the
 *   requirement permission gate + disallowed-tools lock and is hidden from the
 *   normal session list.
 */
export type SessionKind = 'normal' | 'requirement'

export interface SessionRuntime {
  /** Real SDK id, or a `pending:…` id until the first run binds it. */
  sessionId: string
  workspacePath: string
  mode: PermissionMode
  /** Normal user session vs. read-only requirement-communication session. */
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
  viewers: Set<Viewer>
}

const runtimes = new Map<string, SessionRuntime>()

let onStatusChange: (() => void) | null = null
/** Register the global status-change listener (the server broadcasts statuses). */
export function setOnStatusChange(cb: (() => void) | null): void {
  onStatusChange = cb
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
  for (const viewer of rt.viewers) viewer(event)
  // Track outstanding (un-decided) permission prompts so the guard below can keep
  // a genuinely-blocked, still-alive run from collapsing to idle.
  if (event.type === 'permission_request') rt.pending.add(event.requestId)
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
  }
  if (next && next !== rt.status) {
    rt.status = next
    onStatusChange?.()
  }
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
  if (!rt || rt.status === status) return
  rt.status = status
  onStatusChange?.()
}

export function addViewer(id: string, viewer: Viewer): void {
  runtimes.get(id)?.viewers.add(viewer)
}

export function removeViewer(id: string, viewer: Viewer): void {
  runtimes.get(id)?.viewers.delete(viewer)
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

/** Abort and drop every runtime under `workspacePath` (workspace removed). */
export function removeRuntimesForWorkspace(workspacePath: string): void {
  for (const [id, rt] of runtimes) {
    if (rt.workspacePath === workspacePath) {
      rt.run?.abort.abort()
      runtimes.delete(id)
    }
  }
}
