import type { SessionInfo } from '@ccc/shared/protocol'

/** A pointer to a viewed session (its workspace + id). */
export interface SessionRef {
  workspacePath: string
  sessionId: string
}

/**
 * Decide what the 「会话」(console) tab should view when it (re)becomes active.
 *
 * The console tab remembers its own last-viewed session (`remembered`),
 * independent of the requirement tab's comm session — so switching tabs never
 * crosses chat content. On entry:
 *  - honor the remembered session as-is (it carries its own workspace, which may
 *    differ from the sidebar's `currentWorkspace`);
 *  - else fall back to the first session of the current workspace's list;
 *  - else there is nothing to show → empty state (clear the chat column).
 *
 * Pure / DOM-free; orchestration (sending `select_session` or clearing) lives in
 * App.vue.
 */
export function consoleEntryTarget(
  remembered: SessionRef | null,
  currentWorkspace: string | null,
  sessions: SessionInfo[],
): { kind: 'select'; ref: SessionRef } | { kind: 'empty' } {
  if (remembered) return { kind: 'select', ref: remembered }
  const first = sessions[0]
  if (first && currentWorkspace) {
    return { kind: 'select', ref: { workspacePath: currentWorkspace, sessionId: first.sessionId } }
  }
  return { kind: 'empty' }
}
