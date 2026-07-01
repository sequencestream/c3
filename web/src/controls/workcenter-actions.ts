import type { WaitUserInvolveEvent, WaitUserInvolveStatus } from '@ccc/shared/protocol'
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
  // run's `sessionKind` + real `sessionId`. Intent-level events (no real session)
  // route to the intent detail page; all other events land in the unified session
  // page where `sessionKind` only chooses the left-list kind.
  // `event.workspaceId` is an opaque id (the store maps the path through
  // `pathToId`), so it is interchangeable with `currentWorkspace`.
  ctx.jumpToSource = (event: WaitUserInvolveEvent): void => {
    const workspace = event.workspaceId || currentWorkspace.value
    if (!workspace || !ctx.client) return
    ctx.setViewMode('workspace')
    // Intent-level events: no real session exists, jump to the intent detail page.
    if (event.intentLevel && event.intentId) {
      ctx.openIntents(workspace)
      ctx.requestedIntentId.value = event.intentId
      return
    }
    ctx.openWorkcenterSession({
      workspaceId: workspace,
      sessionKind: event.sessionKind,
      sessionId: event.sessionId,
      title: event.intentTitle || event.title,
      updatedAt: event.updatedAt,
    })
  }
}
