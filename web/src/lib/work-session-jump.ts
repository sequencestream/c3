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

/**
 * Resolve a one-shot pending select request against the current session list:
 * returns the session id to select once the target lands, or null to keep
 * waiting (target not yet in the list, or no request staged). Pure — clearing
 * the request and calling `selectSession` is the caller's job.
 */
export function resolvePendingWorkSessionSelect(
  requestedSessionId: string | null,
  sessions: SessionInfo[],
): string | null {
  if (!requestedSessionId) return null
  return sessions.some((s) => s.sessionId === requestedSessionId) ? requestedSessionId : null
}
