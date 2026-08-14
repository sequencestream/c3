import type { WaitUserInvolveEvent, WaitUserInvolveStatus } from '@ccc/shared/protocol'
import { resolveSessionJumpTarget } from '@/lib/session-jump'
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
    send({ type: 'list_wait_user_events', workspaceName: workspace, status, limit: 20 })
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
      workspaceName: workspace,
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

  // Jump from a WorkCenter event to its source. Routing is decided by `intentId`
  // alone: any event whose session resolved an owning intent (including
  // intent-level events, which have no real session) lands on that intent's
  // detail page, with `sessionKind` only choosing the sub-tab through the shared
  // session-jump mapping. Events with no owning intent (discussion, automation,
  // standalone sessions) keep landing in the unified session page, where
  // `sessionKind` only chooses the left-list kind.
  // `event.workspaceName` is an opaque id (the store maps the path through
  // `pathToId`), so it is interchangeable with `currentWorkspace`.
  ctx.jumpToSource = (event: WaitUserInvolveEvent): void => {
    const workspace = event.workspaceName || currentWorkspace.value
    if (!workspace || !ctx.client) return
    ctx.setViewMode('workspace')
    if (event.intentId) {
      // spec → 编写规范, intent → 意图会话, work/tool → detail default tab.
      const target = resolveSessionJumpTarget({
        sessionKind: event.sessionKind,
        ownerKind: 'intent',
        ownerId: event.intentId,
      })
      ctx.openIntents(workspace)
      ctx.requestedIntentId.value = event.intentId
      ctx.requestedIntentSubTab.value =
        target?.kind === 'intentDetail' ? (target.tab ?? null) : null
      return
    }
    ctx.openWorkcenterSession({
      workspaceName: workspace,
      sessionKind: event.sessionKind,
      sessionId: event.sessionId,
      title: event.intentTitle || event.title,
      updatedAt: event.updatedAt,
    })
  }
}
