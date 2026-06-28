import type { WaitUserInvolveEvent, WaitUserInvolveStatus } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import {
  resolveSessionJumpTarget,
  type SessionJumpTarget,
  type SessionOwnerKind,
} from '@/lib/session-jump'

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

  ctx.reloadWorkcenter = (status?: WaitUserInvolveStatus): void => {
    const workspace = currentWorkspace.value
    if (!workspace || !ctx.client) return
    ctx.workcenterLoading.value = true
    ctx.workcenterAppendNext.value = false
    send({ type: 'list_wait_user_events', workspaceId: workspace, status, limit: 20 })
  }

  ctx.loadMoreWorkcenter = (
    status: WaitUserInvolveStatus | undefined,
    cursorTime: number,
    cursorExcludeId: string,
  ): void => {
    const workspace = currentWorkspace.value
    if (!workspace || !ctx.client || ctx.workcenterLoading.value || !ctx.workcenterHasMore.value)
      return
    ctx.workcenterLoading.value = true
    ctx.workcenterAppendNext.value = true
    send({
      type: 'list_wait_user_events',
      workspaceId: workspace,
      status,
      cursorTime,
      cursorExcludeId,
      limit: 20,
    })
  }

  ctx.markDoneWorkcenter = (eventId: string): void => {
    if (!ctx.client) return
    send({ type: 'update_wait_user_event', id: eventId, status: 'done' })
    const event = ctx.workcenterEvents.value.find((item) => item.id === eventId)
    if (event) event.status = 'done'
  }

  // Jump from a WorkCenter event to its source tab + item, routed off the producing
  // run's `sessionKind` + real `sessionId`. `event.workspaceId` is an opaque id (the
  // store maps the path through `pathToId`), so it is interchangeable with
  // `currentWorkspace` and is what every jump entry expects.
  ctx.jumpToSource = (event: WaitUserInvolveEvent): void => {
    const workspace = event.workspaceId || currentWorkspace.value
    if (!workspace || !ctx.client) return
    // Switch from workcenter view to workspace view so the target tab renders.
    ctx.setViewMode('workspace')
    const target = resolveSessionJumpTarget({
      sessionKind: event.sessionKind,
      ownerKind: ownerKindForEvent(event),
      ownerId: ownerIdForEvent(event),
    })
    if (target) {
      executeJumpTarget(workspace, target, event.sessionId)
      return
    }
    if (executeLegacyOwnerlessJump(workspace, event)) return
    ctx.enterConsole()
    if (event.sessionId)
      send({ type: 'select_session', workspaceId: workspace, sessionId: event.sessionId })
  }

  function ownerKindForEvent(event: WaitUserInvolveEvent): SessionOwnerKind | null {
    if (event.intentId) return 'intent'
    if (event.sessionKind === 'discussion' && event.sessionId) return 'discussion'
    if (event.sessionKind === 'schedule' && event.sessionId) return 'schedule'
    return null
  }

  function ownerIdForEvent(event: WaitUserInvolveEvent): string | null {
    if (event.intentId) return event.intentId
    if ((event.sessionKind === 'discussion' || event.sessionKind === 'schedule') && event.sessionId)
      return event.sessionId
    return null
  }

  function executeJumpTarget(
    workspace: string,
    target: SessionJumpTarget,
    sourceSessionId: string | null,
  ): void {
    if (target.kind === 'intentDetail') {
      ctx.openIntents(workspace)
      ctx.requestedIntentId.value = target.intentId
      ctx.requestedIntentSubTab.value = target.tab ?? null
      if (target.tab === 'specSession') ctx.openSpecSession(target.intentId)
      return
    }
    if (target.kind === 'intentSessions') {
      ctx.openIntents(workspace)
      ctx.requestedIntentId.value = target.intentId
      ctx.requestedIntentSubTab.value = null
      ctx.requestedMergedTab.value = 'sessions'
      if (sourceSessionId) ctx.selectIntentSession(sourceSessionId)
      return
    }
    if (target.kind === 'discussion') {
      ctx.openDiscussions(workspace)
      ctx.openDiscussion(target.discussionId)
      return
    }
    ctx.openSchedules(workspace)
    for (const [schId, logs] of Object.entries(ctx.scheduleLogs.value)) {
      const match = logs.find((log) => log.sessionId === sourceSessionId)
      if (match || schId === target.scheduleId) {
        ctx.onSelectSchedule(schId)
        if (match) ctx.onSelectExecution(match.id)
        break
      }
    }
  }

  function executeLegacyOwnerlessJump(workspace: string, event: WaitUserInvolveEvent): boolean {
    if (event.sessionKind === 'intent') {
      ctx.openIntents(workspace)
      ctx.requestedIntentId.value = null
      ctx.requestedIntentSubTab.value = null
      ctx.requestedMergedTab.value = event.sessionId ? 'sessions' : null
      if (event.sessionId) ctx.selectIntentSession(event.sessionId)
      return true
    }
    if (event.sessionKind === 'spec') {
      ctx.openIntents(workspace)
      if (!event.sessionId) return true
      const workspaceIntents = ctx.intents.value[workspace] ?? []
      const bySpec = workspaceIntents.find((intent) => intent.specSessionId === event.sessionId)
      const intentId =
        bySpec?.id ??
        (workspaceIntents.some((i) => i.id === event.sessionId) ? event.sessionId : null)
      if (intentId) {
        ctx.requestedIntentId.value = intentId
        ctx.requestedIntentSubTab.value = 'specSession'
        ctx.openSpecSession(intentId)
      }
      return true
    }
    if (event.sessionKind === 'discussion') {
      ctx.openDiscussions(workspace)
      if (event.sessionId) ctx.openDiscussion(event.sessionId)
      return true
    }
    if (event.sessionKind === 'schedule') {
      ctx.openSchedules(workspace)
      return true
    }
    return false
  }
}
