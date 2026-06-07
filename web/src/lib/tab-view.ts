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
 * independent of the intent tab's comm session — so switching tabs never
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

/** The side effects a sidebar workspace-switch click should produce. */
export interface WorkspaceSwitchEffects {
  /** Target equals the current workspace → ignore the click entirely. */
  noop: boolean
  /** Force a fresh `list_sessions` for the target, bypassing the lazy cache. */
  refreshSessions: boolean
  /** Flip the view to the 「会话」(console) tab. */
  enterConsole: boolean
}

/**
 * Decide what switching the current workspace does. Switching always lands on
 * the console tab and force-refreshes the target's session list (so a cached,
 * possibly-stale list is re-fetched); re-selecting the workspace it already
 * points at is a no-op. Session re-binding stays with `consoleEntryTarget` — no
 * new selection strategy here.
 *
 * Pure / DOM-free; orchestration (sending `list_sessions`, flipping the tab)
 * lives in App.vue.
 */
export function workspaceSwitchEffects(
  target: string,
  current: string | null,
): WorkspaceSwitchEffects {
  if (target === current) return { noop: true, refreshSessions: false, enterConsole: false }
  return { noop: false, refreshSessions: true, enterConsole: true }
}

/** The side effects a top-bar 「会话」(console) tab click should produce. */
export interface ConsoleTabEntryEffects {
  /** Re-bind the chat column to the console tab's own session (it may currently
   *  show another tab's comm session). */
  rebind: boolean
  /** Force a fresh `list_sessions` for the current workspace, so a cached,
   *  possibly-stale list is re-fetched on entry. */
  refreshSessions: boolean
}

/**
 * Decide what clicking the 「会话」(console) tab does. Both effects fire only when
 * arriving from another tab (`wasOther`): clicking the already-active console tab
 * is a no-op for the view (no re-bind, no refresh). The actual `list_sessions`
 * send carries its own empty-workspace guard in `refreshSessions` (App.vue).
 *
 * Pure / DOM-free; orchestration (re-binding, sending `list_sessions`) lives in
 * App.vue's `switchToConsoleTab`.
 */
export function consoleTabEntryEffects(wasOther: boolean): ConsoleTabEntryEffects {
  return { rebind: wasOther, refreshSessions: wasOther }
}
