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
 * The CREATE side of the event lifecycle. Two handlers: {@link
 * createPermissionRequestHandler} lands a `status: 'todo'` event before a human
 * prompt (and broadcasts the refreshed todo list); {@link
 * createConsensusAutoHandler} lands a non-blocking `status: 'auto'` audit record
 * when consensus auto-resolves (no human, no broadcast). Resolution / cancellation
 * live in the permissions handler and the run-domain subscriptions.
 */
import type { Broadcaster } from '../../transport/index.js'
import type { ConsensusAutoCtx, PermissionRequestCtx } from '../../kernel/permission/gateway.js'
import { createEvent, listEvents } from './store.js'
import { getByC3Id } from '../works/work-session-store.js'

/** Resolve a session's human-readable title from the projection (graceful: null on miss/error). */
function lookupTitle(sessionId: string): string | null {
  try {
    const meta = getByC3Id(sessionId)
    return meta ? meta.title : null
  } catch {
    // Non-fatal: a store error during title lookup must never break the gate path.
    return null
  }
}

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
    const title = lookupTitle(ctx.sessionId)

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

/**
 * Build the `onConsensusResolved` handler — the audit twin of {@link
 * createPermissionRequestHandler}. The permission gateway calls it when the
 * multi-agent consensus auto-resolves a tool (the `consensus_auto` path, no human
 * prompt). It records a NON-blocking {@link WaitUserInvolveEvent} with `status:
 * 'auto'` and the deciding consensus {@link ConsensusAutoCtx.outcome}, so the
 * automatic decision is auditable in WorkCenter without ever entering the 'todo'
 * badge count.
 *
 * Deliberately does NOT broadcast: `wait_user_events` carries only the 'todo' list
 * (the badge source), and an 'auto' record is never a todo. It surfaces when a
 * client lists events (the WorkCenter `auto` filter re-fetches), mirroring how
 * 'done' / 'canceled' history is pulled rather than pushed.
 */
export function createConsensusAutoHandler(): (ctx: ConsensusAutoCtx) => void {
  return (ctx: ConsensusAutoCtx): void => {
    // Audit-only and non-blocking: a persistence failure (e.g. db unavailable)
    // must NEVER break the live run that the consensus just unblocked. Swallow it.
    try {
      createEvent({
        workspacePath: ctx.workspacePath,
        source: ctx.source,
        sourceId: ctx.sessionId,
        title: lookupTitle(ctx.sessionId),
        requestId: ctx.requestId,
        toolName: ctx.toolName,
        toolInput: ctx.input,
        status: 'auto',
        outcome: ctx.outcome,
      })
    } catch (err) {
      console.warn(
        `[c3] consensus-auto audit record failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
