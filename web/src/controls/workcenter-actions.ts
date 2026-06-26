import type { WaitUserInvolveEvent } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

// Install WorkCenter event actions (resolve permission + jump-to-source) onto the ctx.
export function installWorkcenterActions(ctx: AppCtx): void {
  const send = ctx.send
  const { currentWorkspace } = ctx

  // WorkCenter event actions (WaitUserInvolveEvent → permission_response).
  ctx.respondWorkcenter = (event: WaitUserInvolveEvent, decision: 'allow' | 'deny'): void => {
    if (!ctx.client || !event.requestId) return
    send({ type: 'permission_response', requestId: event.requestId, decision })
    // Mark it done locally so the badge drops immediately.
    event.status = 'done'
  }

  ctx.submitAskWorkcenter = (
    event: WaitUserInvolveEvent,
    answers: Record<string, string>,
  ): void => {
    if (!ctx.client || !event.requestId) return
    send({
      type: 'permission_response',
      requestId: event.requestId,
      decision: 'allow',
      answers,
    })
    event.status = 'done'
  }

  // Re-fetch the full event list (no status filter ⇒ all statuses, incl. 'auto'
  // audit records and 'done'/'canceled' history). The live broadcast only pushes
  // 'todo'; the WorkCenter filter bar calls this so non-todo tabs are reliable.
  // `currentWorkspace` holds the opaque workspace id — the same id the server
  // resolves back to a path in `list_wait_user_events`.
  ctx.reloadWorkcenter = (): void => {
    const workspace = currentWorkspace.value
    if (!workspace || !ctx.client) return
    send({ type: 'list_wait_user_events', workspaceId: workspace })
  }

  // Jump from a WorkCenter event to its source tab + item. `event.workspaceId` is an
  // opaque id (the store maps the path through `pathToId`), so it is interchangeable
  // with `currentWorkspace` and is what every jump entry expects.
  ctx.jumpToSource = (event: WaitUserInvolveEvent): void => {
    const workspace = event.workspaceId || currentWorkspace.value
    if (!workspace || !ctx.client) return
    switch (event.source) {
      case 'intent':
        jumpToIntent(workspace, event.sourceId)
        break
      case 'spec':
        jumpToSpec(workspace, event.sourceId)
        break
      case 'discussion':
        ctx.openDiscussions(workspace)
        if (event.sourceId) ctx.openDiscussion(event.sourceId)
        break
      case 'schedule':
        ctx.openSchedules(workspace)
        if (event.sourceId) ctx.onSelectSchedule(event.sourceId)
        break
      case 'work':
      default:
        // 'work' and any legacy / unknown source (e.g. a historic 'session' row that
        // escaped the store migration) route to the console: select the session when
        // a sourceId is present, else just enter the console (explicit degradation).
        ctx.enterConsole()
        if (event.sourceId)
          send({ type: 'select_session', workspaceId: workspace, sessionId: event.sourceId })
        break
    }
  }

  // Resolve an 'intent' event's ambiguous sourceId: it is EITHER an intent object id
  // (Start-Dev cleanup events) OR an intent comm-session id (save_intents gate). Open
  // the Intents tab, then disambiguate against the loaded lists — intent object first,
  // then comm session. Neither match (lists not loaded, or the target was deleted) ⇒
  // stay on the Intents tab with no selection rather than silently mis-jumping.
  function jumpToIntent(workspace: string, sourceId: string | null): void {
    ctx.openIntents(workspace)
    if (!sourceId) return
    if ((ctx.intents.value[workspace] ?? []).some((i) => i.id === sourceId)) {
      ctx.requestedIntentId.value = sourceId
    } else if ((ctx.intentSessions.value[workspace] ?? []).some((s) => s.sessionId === sourceId)) {
      ctx.selectIntentSession(sourceId)
    }
  }

  // Resolve a 'spec' event: sourceId is the owning intent id (spec authoring binds to
  // one intent). Open the Intents tab, select the intent, and open its spec session.
  // An unresolvable / missing intent degrades to the Intents tab with no selection.
  function jumpToSpec(workspace: string, sourceId: string | null): void {
    ctx.openIntents(workspace)
    if (!sourceId) return
    if ((ctx.intents.value[workspace] ?? []).some((i) => i.id === sourceId)) {
      ctx.requestedIntentId.value = sourceId
      ctx.openSpecSession(sourceId)
    }
  }
}
