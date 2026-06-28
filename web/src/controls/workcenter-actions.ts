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
  // run's `sessionKind` + real `sessionId`. `event.workspaceId` is an opaque id (the
  // store maps the path through `pathToId`), so it is interchangeable with
  // `currentWorkspace` and is what every jump entry expects.
  ctx.jumpToSource = (event: WaitUserInvolveEvent): void => {
    const workspace = event.workspaceId || currentWorkspace.value
    if (!workspace || !ctx.client) return
    // Switch from workcenter view to workspace view so the target tab renders.
    ctx.setViewMode('workspace')
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
        jumpToSchedule(workspace, event.sessionId)
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

  // sessionKind=intent 路由：始终进入意图页面的「意图会话」列表视图。
  //   有 sessionId → 切到会话列表 tab，右栏展示该会话；命中首页列表则左侧高亮。
  //   无 sessionId → 仅停在意图页，不做选择。
  function jumpToIntent(workspace: string, sessionId: string | null): void {
    ctx.openIntents(workspace)
    if (!sessionId) {
      ctx.requestedMergedTab.value = null
      ctx.requestedIntentId.value = null
      ctx.requestedIntentSubTab.value = null
      return
    }

    ctx.requestedIntentId.value = null
    ctx.requestedIntentSubTab.value = null
    ctx.requestedMergedTab.value = 'sessions'
    ctx.selectIntentSession(sessionId)
  }

  // sessionKind=spec: spec 编写会话 → 打开所属意图的 spec 会话 tab。
  // sessionId 可能是 specSessionId 或意图 id（旧写入路径）。
  function jumpToSpec(workspace: string, sessionId: string | null): void {
    ctx.openIntents(workspace)
    if (!sessionId) return

    const workspaceIntents = ctx.intents.value[workspace] ?? []

    // 优先按 specSessionId 匹配
    const intentBySpecId = workspaceIntents.find((i) => i.specSessionId === sessionId)
    if (intentBySpecId) {
      ctx.requestedIntentId.value = intentBySpecId.id
      ctx.requestedIntentSubTab.value = 'specSession'
      ctx.openSpecSession(intentBySpecId.id)
      return
    }

    // 兜底：sessionId 即意图 id（旧写入路径）
    if (workspaceIntents.some((i) => i.id === sessionId)) {
      ctx.requestedIntentId.value = sessionId
      ctx.requestedIntentSubTab.value = 'specSession'
      ctx.openSpecSession(sessionId)
    }
  }

  // sessionKind=schedule: 在所有已加载的执行日志中查找匹配 sessionId 的
  // 执行记录，选中对应 schedule 并展示该执行记录。
  function jumpToSchedule(workspace: string, sessionId: string | null): void {
    ctx.openSchedules(workspace)
    if (!sessionId) return
    // 遍历所有已加载的 schedule 执行日志，查找匹配的 sessionId
    for (const [schId, logs] of Object.entries(ctx.scheduleLogs.value)) {
      const match = logs.find((l) => l.sessionId === sessionId)
      if (match) {
        ctx.onSelectSchedule(schId)
        ctx.onSelectExecution(match.id)
        return
      }
    }
    // 未找到 → 降级到 schedule 列表
  }
}
