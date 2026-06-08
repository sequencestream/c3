/**
 * `intents` feature handlers — slice 1/3 (ADR-0009).
 *
 * Intent ledger view: list, comm-session open/new/refine, dev launch,
 * status/automation toggles, and the automation orchestrator start/stop. The
 * runStatus cache + judged-sessions de-dup live in `./run-status`; the automation
 * hooks bag in `./automation` (both feature-private). Cross-feature services
 * (launcher, broadcasts) are reached via `ctx`; per-connection delivery via `conn`.
 */
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import {
  addViewer,
  ensureRuntime,
  getRuntime,
  isRunning,
  removeRuntime,
  removeViewer,
} from '../../runs.js'
import { hasWorkspace, setSessionMode, touchWorkspace } from '../../state.js'
import { getDefaultMode, getDevSkill } from '../../kernel/config/index.js'
import { loadHistory, loadLastAssistantMessages, sessionExists } from '../../sessions.js'
import {
  getChatSession,
  getIntent,
  isStoreAvailable,
  listChatSessions,
  listIntents,
  rebindChatSession,
  renameChatSession,
  deleteChatSession,
  setAutomate,
  setChatSession,
  setLastDevSession,
  updateStatus,
} from './store.js'
import { reconcileInProgress } from './reconcile.js'
import { judgeCompletion } from './judge.js'
import {
  cacheRunStatus,
  clearJudgedSession,
  clearRunStatus,
  enrichRunStatus,
  getJudgedSession,
  setJudgedSession,
} from './run-status.js'
import {
  getAutomationHooks,
  getAutomationStatus,
  startAutomation,
  stopAutomation,
} from './automation.js'
import { getDiscussion } from '../discussions/store.js'
import { commitAndPush } from '../../git.js'
import type { Handler } from '../../transport/handler-registry.js'

export const listIntentsHandler: Handler<'list_intents'> = (_ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  conn.send({
    type: 'intents',
    projectPath: proj,
    items: listIntents(proj, msg.status),
  })
}

export const openIntentChat: Handler<'open_intent_chat'> = async (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!hasWorkspace(proj)) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  // Stop viewing whatever this connection had open.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)

  // If a specific sessionId was requested, verify it exists for this project.
  // Otherwise, fall back to is_current (same as before).
  let chatId: string
  if (msg.sessionId) {
    const sessions = listChatSessions(proj)
    if (!sessions.some((s) => s.sessionId === msg.sessionId)) {
      conn.send({
        type: 'error',
        error: { code: 'intent.chatSessionNotFound', params: { sessionId: msg.sessionId } },
      })
      return
    }
    chatId = msg.sessionId
    // Make this session the default for future no-sessionId opens.
    setChatSession(proj, chatId)
    if (!getRuntime(chatId)) {
      const isPending = chatId.startsWith(PENDING_SESSION_PREFIX)
      const baseline = isPending ? [] : await loadHistory(proj, chatId).catch(() => [])
      ensureRuntime(chatId, proj, 'default', baseline, 'intent')
    }
  } else {
    // Resume the project's persisted comm session (is_current), or open a new one.
    const existing = getChatSession(proj)
    if (existing) {
      chatId = existing
      if (!getRuntime(chatId)) {
        const isPending = chatId.startsWith(PENDING_SESSION_PREFIX)
        const baseline = isPending ? [] : await loadHistory(proj, chatId).catch(() => [])
        ensureRuntime(chatId, proj, 'default', baseline, 'intent')
      }
    } else {
      chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
      ensureRuntime(chatId, proj, 'default', [], 'intent')
      setChatSession(proj, chatId)
    }
  }
  const rt = getRuntime(chatId)
  if (!rt) {
    conn.send({ type: 'error', error: { code: 'intent.chatOpenFailed' } })
    return
  }
  conn.viewing = chatId
  touchWorkspace(proj, Date.now())
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: 'New Intent',
    mode: 'default',
    history: rt.baseline,
    status: rt.status,
  })
  for (const e of rt.buffer) conn.send(e)
  addViewer(chatId, conn.deliver)

  // (A) Send the intent list IMMEDIATELY so the panel renders without
  // waiting on reconciliation. runStatus comes from the live registry / cache
  // (enrichRunStatus); the expensive part — judging dead dev sessions — runs in
  // the background below and re-broadcasts the refreshed list once it settles.
  conn.send({
    type: 'intents',
    projectPath: proj,
    items: enrichRunStatus(listIntents(proj)),
  })
  conn.send({ type: 'automation_status', status: getAutomationStatus(proj) })

  // Reconcile in_progress intents in the background: for each, check
  // liveness and auto-complete if the process is dead but the judge confirms
  // done. Never blocks the list send above.
  const inProgReqs = listIntents(proj).filter((r) => r.status === 'in_progress')
  // (B) Skip a intent whose CURRENT dead session was already judged (same
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
          cacheRunStatus(r.intentId, r.runStatus)
          // Record the dead session we judged so (B) can skip it next time; a
          // still-running process keeps being re-derived instead.
          const sid = sessionById.get(r.intentId)
          if (sid && r.runStatus !== 'running') setJudgedSession(r.intentId, sid)
        }
        // Push the refreshed list (updated runStatus + any auto-completes).
        ctx.broadcastIntents(proj)
      })
      .catch((err) => {
        console.warn(`[c3:reconcile] 对账异常: ${err instanceof Error ? err.message : String(err)}`)
      })
  }
}

export const newIntentChat: Handler<'new_intent_chat'> = (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!hasWorkspace(proj)) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: msg.projectPath } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  // Open a brand-new comm session: setChatSession resets the prior is_current
  // row to 0 and marks this one current, so a refresh / reconnect via
  // open_intent_chat resumes THIS session.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'intent')
  setChatSession(proj, chatId)
  conn.viewing = chatId
  touchWorkspace(proj, Date.now())
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: 'New Intent',
    mode: 'default',
    history: [],
    status: rt.status,
  })
  conn.send({
    type: 'intents',
    projectPath: proj,
    items: enrichRunStatus(listIntents(proj)),
  })
  conn.send({ type: 'automation_status', status: getAutomationStatus(proj) })
}

export const refineIntent: Handler<'refine_intent'> = async (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const req = getIntent(msg.intentId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  // Restart the comm session as a fresh one seeded with this intent.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'intent')
  setChatSession(proj, chatId, req.title)
  conn.viewing = chatId
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: req.title,
    mode: 'default',
    history: [],
    status: 'idle',
  })
  conn.send({ type: 'intents', projectPath: proj, items: listIntents(proj) })
  const firstPrompt = `开始完善已存在意图 ${req.id}(当前状态:${req.status})。标题:${req.title}。当前内容:${req.content}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_intents 并在该条目上回填 id="${req.id}" 以原地更新原意图(切勿新建重复项)。若该意图已处于 in_progress 或 done 则无法修改,请告知我。`
  const _boundSub = ctx.eventBus.subscribe('run:bound', (e) => {
    rebindChatSession(e.prevId, e.realId)
    if (conn.viewing === e.prevId) conn.viewing = e.realId
    conn.send({ type: 'session_started', clientId: e.prevId, sessionId: e.realId })
    _boundSub() // auto-dispose after first bound
  })
  try {
    await ctx.launchRun(rt, firstPrompt)
  } finally {
    _boundSub() // safety-net cleanup if bound never fired
  }
}

export const discussionToIntent: Handler<'discussion_to_intent'> = async (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
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
  const rt = ensureRuntime(chatId, proj, 'default', [], 'intent')
  setChatSession(proj, chatId, discussion.title)
  conn.viewing = chatId
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: discussion.title,
    mode: 'default',
    history: [],
    status: 'idle',
  })
  conn.send({ type: 'intents', projectPath: proj, items: listIntents(proj) })
  const firstPrompt = `基于以下讨论结论拆分出可验证的需求条目。讨论:${discussion.title}。结论:${discussion.conclusion}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_intents。`
  const _boundSub = ctx.eventBus.subscribe('run:bound', (e) => {
    rebindChatSession(e.prevId, e.realId)
    if (conn.viewing === e.prevId) conn.viewing = e.realId
    conn.send({ type: 'session_started', clientId: e.prevId, sessionId: e.realId })
    _boundSub() // auto-dispose after first bound
  })
  try {
    await ctx.launchRun(rt, firstPrompt)
  } finally {
    _boundSub() // safety-net cleanup if bound never fired
  }
}

// ── Intent-communication-session CRUD (session-collection upgrade) ──

export const listIntentSessions: Handler<'list_intent_sessions'> = (_ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const items = listChatSessions(proj)
  const runStates: Record<string, 'running'> = {}
  let found = false
  for (const it of items) {
    if (isRunning(it.sessionId)) {
      runStates[it.sessionId] = 'running'
      found = true
    }
  }
  conn.send({
    type: 'intent_sessions',
    projectPath: proj,
    items,
    runStates: found ? runStates : undefined,
  })
}

export const renameIntentSession: Handler<'rename_intent_session'> = (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  try {
    renameChatSession(msg.sessionId, msg.title)
    ctx.broadcastIntentSessions(proj)
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'intent.renameChatSessionFailed', params: { detail: String(err) } },
    })
  }
}

export const deleteIntentSession: Handler<'delete_intent_session'> = (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  try {
    // Remove runtime (abort + drop) BEFORE the db row so no stale runtime lingers.
    removeRuntime(msg.sessionId)
    deleteChatSession(msg.projectPath, msg.sessionId)
    if (conn.viewing === msg.sessionId) conn.viewing = null
    ctx.broadcastIntentSessions(proj)
    ctx.broadcastStatuses()
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'intent.deleteChatSessionFailed', params: { detail: String(err) } },
    })
  }
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
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const req = getIntent(msg.intentId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
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
      error: { code: 'intent.cannotStartDev', params: { status: req.status } },
    })
    return
  }
  const devId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const devRt = ensureRuntime(devId, proj, getDefaultMode(proj), [], 'normal')
  const depNote = req.dependsOn.length ? `\n\n依赖需求:${req.dependsOn.join(', ')}` : ''
  const skill = getDevSkill(proj)
  const skillPrefix = skill ? `${skill} ` : ''
  const devPrompt = `${skillPrefix}${req.title}\n\n${req.content}${depNote}`
  // Background launch: don't await — it runs detached, surviving this
  // connection. Status flips to in_progress once the SDK id binds.
  // Subscribe to kernel event bus for lifecycle events (ADR-0018).
  const disposers: (() => void)[] = []
  disposers.push(
    ctx.eventBus.subscribe('run:bound', (e) => {
      setSessionMode(e.realId, devRt.mode)
      setLastDevSession(req.id, e.realId)
      updateStatus(req.id, 'in_progress')
      ctx.broadcastIntents(proj)
      conn.send({ type: 'session_started', clientId: e.prevId, sessionId: e.realId })
    }),
  )
  disposers.push(
    ctx.eventBus.subscribe('run:settled', (e) => {
      void conn.sendSessions(e.workspacePath)
      // Clean up both subscriptions (settled always fires in the finally block).
      disposers.forEach((d) => d())
    }),
  )
  void ctx.launchRun(devRt, devPrompt)
}

export const updateIntentStatus: Handler<'update_intent_status'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const req = getIntent(msg.intentId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  updateStatus(msg.intentId, msg.status)
  // If the intent leaves in_progress, clear its cache entry so a future
  // restart doesn't show a stale dangling/running label.
  if (req.status === 'in_progress' && msg.status !== 'in_progress') {
    clearRunStatus(msg.intentId)
    clearJudgedSession(msg.intentId)
  }
  ctx.broadcastIntents(req.projectPath)
}

export const setIntentAutomate: Handler<'set_intent_automate'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const req = getIntent(msg.intentId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  setAutomate(msg.intentId, msg.automate)
  ctx.broadcastIntents(req.projectPath)
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
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  ctx.broadcastAutomation(startAutomation(proj, getAutomationHooks(), Date.now()))
}

export const stopAutomationHandler: Handler<'stop_automation'> = (ctx, conn, msg) => {
  const proj = resolve(msg.projectPath)
  ctx.broadcastAutomation(stopAutomation(proj))
}
