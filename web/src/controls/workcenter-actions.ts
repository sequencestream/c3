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

  // sessionKind=intent 路由：
  //   sessionId 匹配 intent.intentSessionId → 选中意图，展示意图会话 tab
  //   sessionId 匹配 intent.specSessionId   → 选中意图，展示 spec 会话 tab
  //   无匹配 → 切到会话列表 tab，选中对应会话
  function jumpToIntent(workspace: string, sessionId: string | null): void {
    ctx.openIntents(workspace)
    if (!sessionId) {
      ctx.requestedMergedTab.value = null
      ctx.requestedIntentSubTab.value = null
      return
    }

    const workspaceIntents = ctx.intents.value[workspace] ?? []

    // Case 1: sessionId == intent.intentSessionId → select intent + show intentSession tab
    const intentBySessionId = workspaceIntents.find((i) => i.intentSessionId === sessionId)
    if (intentBySessionId) {
      ctx.requestedIntentId.value = intentBySessionId.id
      ctx.requestedIntentSubTab.value = 'intentSession'
      ctx.requestedMergedTab.value = null
      ctx.selectIntentSession(sessionId)
      return
    }

    // Case 2: sessionId == intent.specSessionId → select intent + show specSession tab
    const intentBySpecId = workspaceIntents.find((i) => i.specSessionId === sessionId)
    if (intentBySpecId) {
      ctx.requestedIntentId.value = intentBySpecId.id
      ctx.requestedIntentSubTab.value = 'specSession'
      ctx.requestedMergedTab.value = null
      ctx.openSpecSession(intentBySpecId.id)
      return
    }

    // Case 3: no match → show session list tab + select the session
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
