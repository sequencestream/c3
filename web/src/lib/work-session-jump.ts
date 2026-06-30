import type { Intent, SessionInfo } from '@ccc/shared/protocol'
import type { DevLaunchCloseReason } from './dev-launch-view'

/*
 * work-session-jump — pure decision logic for the post-Start-Dev jump.
 *
 * After a manual `start_development` resolves to `ready` (the startup overlay
 * closes), the view auto-bridges "launched → watch progress": it flips to the
 * console (works) tab and selects the work session this launch created for the
 * intent. This module holds only the decisions (no DOM, no timers, no `send`);
 * the control layer wires it to `setTimeout` / tab switch / `selectSession`
 * while the logic stays unit-testable.
 */

/**
 * The deliberate "已就绪" visual buffer between the overlay closing and the jump.
 * The jump fires AFTER the overlay closes, not the instant it does.
 */
export const WORK_SESSION_JUMP_DELAY_MS = 1000

export interface PendingWorkSessionSelectRequest {
  workspacePath: string
  intentId: string
  sessionId: string | null
}

export interface PendingWorkSessionSelectContext {
  workspacePath: string | null
  sessionKind: string
  intents: Intent[]
  sessions: SessionInfo[]
}

export interface PendingWorkSessionSelectResult {
  request: PendingWorkSessionSelectRequest | null
  selectSessionId: string | null
}

/**
 * Whether a dev-launch terminal should trigger the jump. Only the success
 * terminal (`ready`) jumps; `failed` / `timeout` stay on the intents page with
 * their toast. `undefined` (the overlay merely advanced, did not close) never jumps.
 */
export function shouldJumpAfterDevLaunch(closedReason: DevLaunchCloseReason | undefined): boolean {
  return closedReason === 'ready'
}

/**
 * Resolve the jump target work-session id for an intent from the latest intent
 * list: this launch's `lastDevSessionId`, the only client-side reverse lookup
 * (list rows carry no `linkedIntentId`). Returns null when the intent is absent
 * or has no dev session yet — the caller then does not jump.
 */
export function resolveJumpTargetSessionId(intentId: string, intents: Intent[]): string | null {
  return intents.find((it) => it.id === intentId)?.lastDevSessionId ?? null
}

export function beginPendingWorkSessionSelect(
  workspacePath: string,
  intentId: string,
): PendingWorkSessionSelectRequest {
  return { workspacePath, intentId, sessionId: null }
}

/**
 * Resolve a one-shot pending select request against the latest intent and
 * session lists. Pure — storing the returned request and calling `selectSession`
 * is the caller's job.
 */
export function resolvePendingWorkSessionSelect(
  request: PendingWorkSessionSelectRequest | null,
  context: PendingWorkSessionSelectContext,
): PendingWorkSessionSelectResult {
  if (!request) return { request: null, selectSessionId: null }
  if (context.workspacePath !== request.workspacePath || context.sessionKind !== 'work') {
    return { request, selectSessionId: null }
  }
  const sessionId = request.sessionId ?? resolveJumpTargetSessionId(request.intentId, context.intents)
  if (!sessionId) return { request, selectSessionId: null }
  if (context.sessions.some((s) => s.sessionId === sessionId)) {
    return { request: null, selectSessionId: sessionId }
  }
  return { request: { ...request, sessionId }, selectSessionId: null }
}
