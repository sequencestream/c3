import type { ChatMsg } from './chat-types'

/**
 * The `requestId` of the single permission the user can still act on, or null.
 *
 * A permission is *actionable* only while the session is genuinely blocked on it:
 * the session must be awaiting a decision, and this must be the latest, still
 * un-decided permission in the transcript (the SDK blocks on one permission at a
 * time, so the last undecided one is the live request). Every earlier permission
 * — and any permission replayed from history once the session has moved on — is
 * non-actionable and renders as a static record instead of a clickable card.
 *
 * `awaiting` is the viewed session's `awaiting_permission` status; keeping it a
 * parameter makes this a pure function of the transcript + status. The server
 * holds a live run at `awaiting_permission` for as long as an un-answered prompt
 * is outstanding (it won't let a stray `turn_end` flip it to idle — see
 * `runs.ts` emit guard), so a still-answerable AskUserQuestion panel never
 * downgrades to a static history line while the run is alive.
 */
export function actionablePermissionId(messages: ChatMsg[], awaiting: boolean): string | null {
  if (!awaiting) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'permission') return m.decision === null ? m.requestId : null
  }
  return null
}
