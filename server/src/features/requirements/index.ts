/**
 * `requirements` feature handlers — slice 1/3 (ADR-0009).
 *
 * Requirement ledger view: list, comm-session open/new/refine, dev launch,
 * status/automation toggles, and the automation orchestrator start/stop. The
 * runStatus cache + judged-sessions de-dup are feature-private in
 * `requirements/run-status`; cross-feature services (automation hooks, launcher,
 * broadcasts) are reached via `ctx`; per-connection `viewing` + delivery via `conn`.
 */
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { addViewer, ensureRuntime, getRuntime, isRunning, removeViewer } from '../../runs.js'
import { hasWorkspace, setSessionMode, touchWorkspace } from '../../state.js'
import { getDefaultMode, getDevSkill } from '../../settings.js'
import { loadHistory, loadLastAssistantMessages, sessionExists } from '../../sessions.js'
import {
  getChatSession,
  getRequirement,
  isStoreAvailable,
  listRequirements,
  rebindChatSession,
  setAutomate,
  setChatSession,
  setLastDevSession,
  updateStatus,
} from '../../requirements/store.js'
import { reconcileInProgress } from '../../requirements/reconcile.js'
import { judgeCompletion } from '../../requirements/judge.js'
import {
  cacheRunStatus,
  clearJudgedSession,
  clearRunStatus,
  enrichRunStatus,
  getJudgedSession,
  setJudgedSession,
} from '../../requirements/run-status.js'
import {
  getAutomationStatus,
  startAutomation,
  stopAutomation,
} from '../../requirements/automation.js'
import { getDiscussion } from '../discussions/store.js'
import { commitAndPush } from '../../git.js'
import type { Handler } from '../../transport/handler-registry.js'

export const listRequirementsHandler: Handler<'list_requirements'> = (_ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  conn.send({
    type: 'requirements',
    projectPath: proj,
    items: listRequirements(proj, msg.status),
  })
}

export const openRequirementChat: Handler<'open_requirement_chat'> = async (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!hasWorkspace(proj)) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  // Stop viewing whatever this connection had open.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  // Resume the project's persisted comm session, or open a new one. This is the
  // single path hit on first entry, WS reconnect, and a hard refresh — all
  // "auto-reload the last comm session".
  const existing = getChatSession(proj)
  let chatId: string
  if (existing) {
    chatId = existing
    if (!getRuntime(chatId)) {
      const isPending = chatId.startsWith(PENDING_SESSION_PREFIX)
      const baseline = isPending ? [] : await loadHistory(proj, chatId).catch(() => [])
      ensureRuntime(chatId, proj, 'default', baseline, 'requirement')
    }
  } else {
    chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
    ensureRuntime(chatId, proj, 'default', [], 'requirement')
    setChatSession(proj, chatId)
  }
  const rt = getRuntime(chatId)
  if (!rt) {
    conn.send({ type: 'error', error: { code: 'requirement.chatOpenFailed' } })
    return
  }
  conn.viewing = chatId
  touchWorkspace(proj, Date.now())
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: 'New Requirement',
    mode: 'default',
    history: rt.baseline,
    status: rt.status,
  })
  for (const e of rt.buffer) conn.send(e)
  addViewer(chatId, conn.deliver)

  // (A) Send the requirement list IMMEDIATELY so the panel renders without
  // waiting on reconciliation. runStatus comes from the live registry / cache
  // (enrichRunStatus); the expensive part — judging dead dev sessions — runs in
  // the background below and re-broadcasts the refreshed list once it settles.
  conn.send({
    type: 'requirements',
    projectPath: proj,
    items: enrichRunStatus(listRequirements(proj)),
  })
  conn.send({ type: 'automation_status', status: getAutomationStatus(proj) })

  // Reconcile in_progress requirements in the background: for each, check
  // liveness and auto-complete if the process is dead but the judge confirms
  // done. Never blocks the list send above.
  const inProgReqs = listRequirements(proj).filter((r) => r.status === 'in_progress')
  // (B) Skip a requirement whose CURRENT dead session was already judged (same
  // verdict, saved LLM call). Live processes and brand-new session ids fall
  // through and still get (re)judged.
  const toReconcile = inProgReqs.filter((r) => {
    const dead = !(r.lastDevSessionId && isRunning(r.lastDevSessionId))
    if (!dead) return true
    return !r.lastDevSessionId || getJudgedSession(r.id) !== r.lastDevSessionId
  })
  if (toReconcile.length > 0) {
    const signal = new AbortController()
    const sessionById = new Map(inProgReqs.map((r) => [r.id, r.lastDevSessionId]))
    void reconcileInProgress(
      toReconcile,
      proj,
      {
        isRunning,
        loadTranscriptMessages: (p, sid, count) => loadLastAssistantMessages(p, sid, count),
        judgeCompletion,
        commitAndPush,
        updateStatus,
      },
      signal.signal,
    )
      .then((reconciled) => {
        if (reconciled.length === 0) return
        for (const r of reconciled) {
          // Cache the derived runStatus for enrichRunStatus. Auto-completed items
          // left in_progress, so their entry won't be read again.
          cacheRunStatus(r.requirementId, r.runStatus)
          // Record the dead session we judged so (B) can skip it next time; a
          // still-running process keeps being re-derived instead.
          const sid = sessionById.get(r.requirementId)
          if (sid && r.runStatus !== 'running') setJudgedSession(r.requirementId, sid)
        }
        // Push the refreshed list (updated runStatus + any auto-completes).
        ctx.broadcastRequirements(proj)
      })
      .catch((err) => {
        console.warn(`[c3:reconcile] 对账异常: ${err instanceof Error ? err.message : String(err)}`)
      })
  }
}

export const newRequirementChat: Handler<'new_requirement_chat'> = (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!hasWorkspace(proj)) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  // Open a brand-new comm session: setChatSession resets the prior is_current
  // row to 0 and marks this one current, so a refresh / reconnect via
  // open_requirement_chat resumes THIS session.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'requirement')
  setChatSession(proj, chatId)
  conn.viewing = chatId
  touchWorkspace(proj, Date.now())
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: 'New Requirement',
    mode: 'default',
    history: [],
    status: rt.status,
  })
  conn.send({
    type: 'requirements',
    projectPath: proj,
    items: enrichRunStatus(listRequirements(proj)),
  })
  conn.send({ type: 'automation_status', status: getAutomationStatus(proj) })
}

export const refineRequirement: Handler<'refine_requirement'> = async (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  const req = getRequirement(msg.requirementId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'requirement.notFound' } })
    return
  }
  // Restart the comm session as a fresh one seeded with this requirement.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'requirement')
  setChatSession(proj, chatId)
  conn.viewing = chatId
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: 'New Requirement',
    mode: 'default',
    history: [],
    status: 'idle',
  })
  conn.send({ type: 'requirements', projectPath: proj, items: listRequirements(proj) })
  const firstPrompt = `开始完善需求 ${req.id}。标题:${req.title}。当前内容:${req.content}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_requirements。`
  await ctx.launchRun(rt, firstPrompt, {
    onSessionId: (prev, sid) => {
      rebindChatSession(prev, sid)
      if (conn.viewing === prev) conn.viewing = sid
      conn.send({ type: 'session_started', clientId: prev, sessionId: sid })
    },
  })
}

export const discussionToRequirement: Handler<'discussion_to_requirement'> = async (
  ctx,
  conn,
  msg,
) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  const discussion = getDiscussion(msg.discussionId)
  if (!discussion) {
    conn.send({ type: 'error', error: { code: 'discussion.notFound' } })
    return
  }
  if (discussion.status !== 'completed' || !discussion.conclusion) {
    conn.send({ type: 'error', error: { code: 'discussion.notConcludable' } })
    return
  }
  const proj = resolve(discussion.projectPath)
  // Seed a fresh comm session with the conclusion — a refine variant.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'requirement')
  setChatSession(proj, chatId)
  conn.viewing = chatId
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: 'New Requirement',
    mode: 'default',
    history: [],
    status: 'idle',
  })
  conn.send({ type: 'requirements', projectPath: proj, items: listRequirements(proj) })
  const firstPrompt = `基于以下讨论结论拆分出可验证的需求条目。讨论:${discussion.title}。结论:${discussion.conclusion}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_requirements。`
  await ctx.launchRun(rt, firstPrompt, {
    onSessionId: (prev, sid) => {
      rebindChatSession(prev, sid)
      if (conn.viewing === prev) conn.viewing = sid
      conn.send({ type: 'session_started', clientId: prev, sessionId: sid })
    },
  })
}

export const startDevelopment: Handler<'start_development'> = async (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!hasWorkspace(proj)) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  const req = getRequirement(msg.requirementId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'requirement.notFound' } })
    return
  }
  // Allow `todo`, or `in_progress` whose dev session has gone missing (a
  // dangling launch — let the user restart rather than stay stuck).
  const dangling =
    req.status === 'in_progress' &&
    (!req.lastDevSessionId || !(await sessionExists(proj, req.lastDevSessionId)))
  if (req.status !== 'todo' && !dangling) {
    conn.send({
      type: 'error',
      error: { code: 'requirement.cannotStartDev', params: { status: req.status } },
    })
    return
  }
  const devId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const devRt = ensureRuntime(devId, proj, getDefaultMode(), [], 'normal')
  const depNote = req.dependsOn.length ? `\n\n依赖需求:${req.dependsOn.join(', ')}` : ''
  const skill = getDevSkill()
  const skillPrefix = skill ? `${skill} ` : ''
  const devPrompt = `${skillPrefix}${req.title}\n\n${req.content}${depNote}`
  // Background launch: don't await — it runs detached, surviving this
  // connection. Status flips to in_progress once the SDK id binds.
  void ctx.launchRun(devRt, devPrompt, {
    onSessionId: (prev, sid) => {
      setSessionMode(sid, devRt.mode)
      setLastDevSession(req.id, sid)
      updateStatus(req.id, 'in_progress')
      ctx.broadcastRequirements(proj)
      conn.send({ type: 'session_started', clientId: prev, sessionId: sid })
    },
    onSettled: async (wp) => {
      await conn.sendSessions(wp)
    },
  })
}

export const updateRequirementStatus: Handler<'update_requirement_status'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  const req = getRequirement(msg.requirementId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'requirement.notFound' } })
    return
  }
  updateStatus(msg.requirementId, msg.status)
  // If the requirement leaves in_progress, clear its cache entry so a future
  // restart doesn't show a stale dangling/running label.
  if (req.status === 'in_progress' && msg.status !== 'in_progress') {
    clearRunStatus(msg.requirementId)
    clearJudgedSession(msg.requirementId)
  }
  ctx.broadcastRequirements(req.projectPath)
}

export const setRequirementAutomate: Handler<'set_requirement_automate'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  const req = getRequirement(msg.requirementId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'requirement.notFound' } })
    return
  }
  setAutomate(msg.requirementId, msg.automate)
  ctx.broadcastRequirements(req.projectPath)
}

export const startAutomationHandler: Handler<'start_automation'> = (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!hasWorkspace(proj)) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'requirement.dbUnavailable' } })
    return
  }
  ctx.broadcastAutomation(startAutomation(proj, ctx.automationHooks, Date.now()))
}

export const stopAutomationHandler: Handler<'stop_automation'> = (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  ctx.broadcastAutomation(stopAutomation(proj))
}
