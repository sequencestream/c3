import type { WaitUserInvolveEvent } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

// Install WorkCenter event actions (resolve permission + jump-to-source) onto the ctx.
export function installWorkcenterActions(ctx: AppCtx): void {
  const send = ctx.send
  const { currentWorkspace, activeTab, intentsProject } = ctx

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

  // Jump from a WorkCenter event to its source tab + item.
  ctx.jumpToSource = (event: WaitUserInvolveEvent): void => {
    const path = event.workspacePath || currentWorkspace.value
    if (!path || !ctx.client) return
    switch (event.source) {
      case 'session':
        ctx.enterConsole()
        if (event.sourceId)
          send({ type: 'select_session', workspacePath: path, sessionId: event.sourceId })
        break
      case 'intent':
        activeTab.value = 'intents'
        intentsProject.value = path
        ctx.persistViewMode()
        send({ type: 'open_intent_chat', workspacePath: path })
        send({ type: 'list_intent_sessions', workspacePath: path })
        break
      case 'discussion':
        ctx.openDiscussions(path)
        if (event.sourceId) ctx.openDiscussion(event.sourceId)
        break
      case 'schedule':
        ctx.openSchedules(path)
        if (event.sourceId) ctx.onSelectSchedule(event.sourceId)
        break
    }
  }
}
