/**
 * Socket auto-resume gate (AS-R18/R19) — pure run-lifecycle leaf (server refactor
 * 3/3, ADR-0009, sunk from the old root `claude.ts`). Three pure pieces the run
 * loop and its launcher consult:
 *   1. the side-effect tool classifier ({@link isSideEffectTool}) the SDK message
 *      loop uses to track unclosed write-class tool calls;
 *   2. its pure mirror ({@link computeSideEffectPending}) for unit testing;
 *   3. the resume decision ({@link decideSocketResume}) the launcher applies on a
 *      socket disconnect.
 *
 * No SDK / registry / IO dependency — imported by `kernel/agent` (the run loop)
 * and `kernel/run/run-lifecycle` (the launcher); imports nothing from either, so
 * the boundary stays acyclic (a leaf both sides can reach).
 */

/**
 * The side-effect-free tool allowlist for the auto-resume gate (AS-R19). A tool
 * in this set produces no durable local side effect, so an unclosed `tool_use`
 * for it at disconnect time is safe to auto-resume past. CONSERVATIVE by design:
 * everything NOT in this set — `Write/Edit/MultiEdit/NotebookEdit/Bash`, and any
 * unknown / MCP tool — is treated as a side-effect tool. We would rather miss an
 * auto-resume (fall back to manual continue) than wrongly auto-resume after a
 * write may have half-applied.
 */
const SIDE_EFFECT_FREE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TaskCreate',
  'TaskList',
  'TaskUpdate',
  'TaskGet',
  'AskUserQuestion',
])

/** Whether a tool may have durable side effects for the auto-resume gate (AS-R19). */
export function isSideEffectTool(name: string): boolean {
  return !SIDE_EFFECT_FREE_TOOLS.has(name)
}

/** A simplified SDK message flow item for {@link computeSideEffectPending}. */
export type ToolFlowItem =
  | { type: 'tool_use'; id: string; name: string }
  | { type: 'tool_result'; toolUseId: string }
  | { type: 'text' }

/**
 * Pure tool_use↔tool_result pairing inference (AS-R19). Walk the message flow,
 * adding a side-effect tool's `tool_use` id to an open set and removing it when
 * its `tool_result` returns; the final set being non-empty means a write-class
 * tool call was in flight (no result yet) — so `side_effect_pending` is true and
 * auto-resume must be refused. A trailing plain `text` message, or a flow where
 * every side-effect `tool_use` already has its `tool_result`, yields false.
 */
export function computeSideEffectPending(flow: ToolFlowItem[]): boolean {
  const open = new Set<string>()
  for (const m of flow) {
    if (m.type === 'tool_use') {
      if (isSideEffectTool(m.name)) open.add(m.id)
    } else if (m.type === 'tool_result') {
      open.delete(m.toolUseId)
    }
  }
  return open.size > 0
}

/** Inputs to the socket auto-resume decision (AS-R18/R19), all caller-resolved. */
export interface SocketResumeContext {
  /** The `socketAutoResume` gray-out switch (default true). */
  autoResumeEnabled: boolean
  /** The AS-R19 gate verdict: an unclosed write-class tool_use was in flight. */
  sideEffectPending: boolean
  /** Whether this turn has already spent its single auto-resume. */
  retryAlreadyUsed: boolean
  /** Whether the session id is still a `pending:…` placeholder (no real id to resume). */
  isPendingSession: boolean
  /** Whether the session is a persistent agent team (teams use pushInput, not resume). */
  isTeam: boolean
  /** Whether the run was already aborted (user stop). */
  aborted: boolean
}

/** The terminal `turn_end` a refused/exhausted socket disconnect emits. */
export interface SocketManualTurnEnd {
  type: 'turn_end'
  reason: 'error'
  original_error: string
  side_effect_pending: boolean
  reconnect_attempted: boolean
  retry_count: number
}

export type SocketResumeDecision =
  { action: 'auto-resume' } | { action: 'manual-error'; turnEnd: SocketManualTurnEnd }

/**
 * Pure decision for a socket disconnect (AS-R18/R19): auto-`resume` the same run
 * once, or refuse and end the turn so the user continues manually. Auto-resume is
 * a strict conjunction — the switch is on, the side-effect gate is clear, the
 * single retry is unspent, there is a real session id to resume, it is not a team
 * lead, and the run was not stopped. Any miss falls to a `manual-error` turn_end
 * that records the original error, the gate verdict, and whether a reconnect was
 * attempted (true only when the retry was already spent — i.e. the resume itself
 * disconnected again). Bounded by construction: `manual-error` is terminal.
 */
export function decideSocketResume(error: string, ctx: SocketResumeContext): SocketResumeDecision {
  const canAuto =
    ctx.autoResumeEnabled &&
    !ctx.sideEffectPending &&
    !ctx.retryAlreadyUsed &&
    !ctx.isPendingSession &&
    !ctx.isTeam &&
    !ctx.aborted
  if (canAuto) return { action: 'auto-resume' }
  return {
    action: 'manual-error',
    turnEnd: {
      type: 'turn_end',
      reason: 'error',
      original_error: error,
      side_effect_pending: ctx.sideEffectPending,
      reconnect_attempted: ctx.retryAlreadyUsed,
      retry_count: ctx.retryAlreadyUsed ? 1 : 0,
    },
  }
}
