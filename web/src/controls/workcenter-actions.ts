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

  // Jump from a WorkCenter event to its source tab + item, routed off the producing
  // run's `sessionKind` + real `sessionId`. `event.workspaceId` is an opaque id (the
  // store maps the path through `pathToId`), so it is interchangeable with
  // `currentWorkspace` and is what every jump entry expects.
  ctx.jumpToSource = (event: WaitUserInvolveEvent): void => {
    const workspace = event.workspaceId || currentWorkspace.value
    if (!workspace || !ctx.client) return
    switch (event.sessionKind) {
      case 'intent':
        jumpToIntent(workspace, event.sessionId)
        break
      case 'spec':
        jumpToSpec(workspace, event.sessionId)
        break
      case 'discussion':
        ctx.openDiscussions(workspace)
        if (event.sessionId) ctx.openDiscussion(event.sessionId)
        break
      case 'schedule':
        ctx.openSchedules(workspace)
        if (event.sessionId) ctx.onSelectSchedule(event.sessionId)
        break
      case 'work':
      default:
        // 'work', plus the never-prompting consensus/tool kinds and any legacy /
        // unknown value, route to the console: select the session when a sessionId is
        // present, else just enter the console (explicit degradation).
        ctx.enterConsole()
        if (event.sessionId)
          send({ type: 'select_session', workspaceId: workspace, sessionId: event.sessionId })
        break
    }
  }

  // Resolve an 'intent' event's `sessionId`. The save_intents gate writes the real
  // comm-session id; the Start-Dev cleanup todo writes the intent OBJECT id (no real
  // session to reference). Open the Intents tab, then match against the loaded lists —
  // intent object first, then comm session — so both write paths route sensibly. No
  // match (lists not loaded, target deleted, or a legacy row) ⇒ stay on the Intents
  // tab with no selection rather than silently mis-jumping.
  function jumpToIntent(workspace: string, sessionId: string | null): void {
    ctx.openIntents(workspace)
    if (!sessionId) return
    if ((ctx.intents.value[workspace] ?? []).some((i) => i.id === sessionId)) {
      ctx.requestedIntentId.value = sessionId
    } else if ((ctx.intentSessions.value[workspace] ?? []).some((s) => s.sessionId === sessionId)) {
      ctx.selectIntentSession(sessionId)
    }
  }

  // Resolve a 'spec' event: the spec-authoring run binds to one intent, so its
  // `sessionId` resolves to the owning intent id. Open the Intents tab, select the
  // intent, and open its spec session. An unresolvable / missing intent degrades to
  // the Intents tab with no selection.
  function jumpToSpec(workspace: string, sessionId: string | null): void {
    ctx.openIntents(workspace)
    if (!sessionId) return
    if ((ctx.intents.value[workspace] ?? []).some((i) => i.id === sessionId)) {
      ctx.requestedIntentId.value = sessionId
      ctx.openSpecSession(sessionId)
    }
  }
}
