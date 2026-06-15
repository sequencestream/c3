/**
 * Wait-user-involve event lifecycle hooks.
 *
 * The wiring-layer handler that bridges the permission gateway's
 * `onPermissionRequest` callback to the event store. Receives a full
 * {@link PermissionRequestCtx} from the gateway, creates a {@link
 * WaitUserInvolveEvent} with the session title and tool info, and broadcasts
 * the refreshed event list to every connection — so the pending-items panel
 * updates in real time.
 *
 * This is the CREATE side of the event lifecycle (the only side wired in this
 * intent). Resolution / cancellation is the next intent.
 */
import type { Broadcaster } from '../../transport/index.js'
import type { PermissionRequestCtx } from '../../kernel/permission/gateway.js'
import { createEvent, listEvents } from './store.js'
import { getByC3Id } from '../works/work-session-store.js'

/**
 * Build the `onPermissionRequest` handler that the composition root wires into
 * {@link import('../../kernel/run/run-lifecycle.js').LaunchRunDeps.onPermissionRequest}.
 *
 * Each invocation creates a {@link WaitUserInvolveEvent} via the store, then
 * broadcasts the project's `'todo'` event list to every live connection so the
 * frontend's pending-items panel refreshes immediately.
 */
export function createPermissionRequestHandler(deps: {
  broadcaster: Broadcaster
}): (ctx: PermissionRequestCtx) => void {
  return (ctx: PermissionRequestCtx): void => {
    // Look up the session title from the work_session_metadata projection so the
    // event carries a human-readable label. Gracefully degrades: a missing row
    // (pre-bind, or the rare case of a deleted-then-recreated session) results
    // in a null title — the frontend can then fall back to the id or a default.
    let title: string | null = null
    try {
      const meta = getByC3Id(ctx.sessionId)
      if (meta) title = meta.title
    } catch {
      // Non-fatal: a store error during title lookup must never break the
      // permission_request path. The event is still created with a null title.
    }

    // Persist the event (status defaults to 'todo'). `source` is caller-provided
    // (session / intent / …) so WorkCenter's jumpToSource targets the right tab —
    // a codex intent prompt is 'intent', a work session is 'session'.
    createEvent({
      workspacePath: ctx.workspacePath,
      source: ctx.source,
      sourceId: ctx.sessionId,
      title,
      requestId: ctx.requestId,
      toolName: ctx.toolName,
      toolInput: ctx.input,
    })

    // Broadcast the fresh todo list so every connection sees it.
    const items = listEvents(ctx.workspacePath, 'todo')
    deps.broadcaster.toAll({ type: 'wait_user_events', items })
  }
}
