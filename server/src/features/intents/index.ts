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
import {
  PENDING_SESSION_PREFIX,
  type SessionAgentSwitch,
  type VendorId,
} from '@ccc/shared/protocol'
import {
  addViewer,
  ensureRuntime,
  getRuntime,
  isRunning,
  removeRuntime,
  removeViewer,
} from '../../runs.js'
import { hasWorkspace, touchWorkspace } from '../../state.js'
import {
  getDefaultMainBranch,
  getDefaultMode,
  getDevSkill,
  getGitCommitMode,
} from '../../kernel/config/index.js'
import {
  getDefaultAgentId,
  resolveSessionAgentSwitch,
  resolveSessionVendor,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
import { probeAll } from '../../kernel/agent/process/launcher.js'
import { loadHistory, loadLastAssistantMessages, sessionExists } from '../../sessions.js'
import {
  canTransition,
  getChatSession,
  getIntent,
  isStoreAvailable,
  listChatSessions,
  listIntents,
  renameChatSession,
  deleteChatSession,
  setAutomate,
  setBranchName,
  setChatSession,
  setLatestCommitHash,
  setPrInfo,
  updateIntentDeps,
  updateStatus,
} from './store.js'
import { registerPendingDevLink } from './dev-link.js'
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
import { commitAndPush, createGhPr } from '../../git.js'
import { createWorktree, readBranch } from './worktree.js'
import type { Handler } from '../../transport/handler-registry.js'

// ---- Local helpers (agent binding for intent comm sessions) ----

/** Vendors whose host CLI resolved on PATH (ADR-0012) — inline, not from sessions/ (ADR-0009). */
function presentVendorSet(): Set<VendorId> {
  return new Set(
    probeAll()
      .filter((p) => p.path !== null)
      .map((p) => p.vendor),
  )
}

/** The title-bar agent-switcher payload for a session, or undefined when absent. */
function agentSwitchFor(sessionId: string): SessionAgentSwitch | undefined {
  return resolveSessionAgentSwitch(sessionId, presentVendorSet()) ?? undefined
}

/**
 * Bind the default agent to a newly-created intent comm session (pending id).
 * Must be called after `ensureRuntime` so `resolveSessionLaunch`/agent switcher
 * find the pending intent in later lookups.
 */
function bindDefaultAgent(sessionId: string): void {
  setSessionAgent(sessionId, getDefaultAgentId())
}

// ---- Handlers ----

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
      bindDefaultAgent(chatId)
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
        bindDefaultAgent(chatId)
      }
    } else {
      chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
      ensureRuntime(chatId, proj, 'default', [], 'intent')
      bindDefaultAgent(chatId)
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
  // Resolve the session title from the store; fall back to 'New Intent' for
  // brand-new sessions whose title is still null.
  const dbSessions = listChatSessions(proj)
  const dbSession = dbSessions.find((s) => s.sessionId === chatId)
  const realTitle = dbSession?.title ?? 'New Intent'
  conn.send({
    type: 'session_selected',
    workspacePath: proj,
    sessionId: chatId,
    title: realTitle,
    mode: 'default',
    history: rt.baseline,
    status: rt.status,
    vendor: resolveSessionVendor(chatId),
    agentSwitch: agentSwitchFor(chatId),
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
  bindDefaultAgent(chatId)
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
    vendor: resolveSessionVendor(chatId),
    agentSwitch: agentSwitchFor(chatId),
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
  bindDefaultAgent(chatId)
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
    vendor: resolveSessionVendor(chatId),
    agentSwitch: agentSwitchFor(chatId),
  })
  conn.send({ type: 'intents', projectPath: proj, items: listIntents(proj) })
  const firstPrompt = `开始完善已存在意图 ${req.id}(当前状态:${req.status})。标题:${req.title}。当前内容:${req.content}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_intents 并在该条目上回填 id="${req.id}" 以原地更新原意图(切勿新建重复项)。若该意图已处于 in_progress 或 done 则无法修改,请告知我。`
  await ctx.launchRun(rt, firstPrompt)
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
  bindDefaultAgent(chatId)
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
    vendor: resolveSessionVendor(chatId),
    agentSwitch: agentSwitchFor(chatId),
  })
  conn.send({ type: 'intents', projectPath: proj, items: listIntents(proj) })
  const firstPrompt = `基于以下讨论结论拆分出可验证的需求条目。讨论:${discussion.title}。结论:${discussion.conclusion}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_intents。`
  await ctx.launchRun(rt, firstPrompt)
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
  // ── Git commit strategy (2026-06-10) ───────────────────────────────────
  // The workspace's `gitCommitMode` decides where the dev agent runs:
  //  - `worktree`: create (or reuse) an isolated git worktree at
  //    $TMPDIR/c3-worktrees/<project>/intent-<ID>, branched from the workspace's
  //    default main branch. Idempotent on dangling / resume.
  //  - `current-branch` (default): no worktree — develop in place on the project
  //    checkout's current branch.
  let effectiveCwd: string
  if (getGitCommitMode(proj) === 'worktree') {
    try {
      const wt = createWorktree(proj, req.id, req.title, getDefaultMainBranch(proj))
      effectiveCwd = wt.worktreePath
      setBranchName(req.id, wt.branchName)
    } catch (err) {
      conn.send({
        type: 'error',
        error: {
          code: 'intent.worktreeCreateFailed',
          params: { message: err instanceof Error ? err.message : String(err) },
        },
      })
      return
    }
  } else {
    // current-branch: develop directly in the project checkout. Record the
    // current branch so the intent's branch_name reflects where dev happens.
    effectiveCwd = proj
    const branch = readBranch(proj)
    if (branch) setBranchName(req.id, branch)
  }

  const devId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  // Use the ORIGINAL project path for ensureRuntime so broadcasts (run:bound /
  // run:settled events) use the correct workspace scope. The agent SDK's CWD
  // is overridden via devRt.effectiveCwd (the worktree, or the project checkout
  // itself in current-branch mode).
  const devRt = ensureRuntime(devId, proj, getDefaultMode(proj), [], 'session')
  devRt.effectiveCwd = effectiveCwd
  const depNote = req.dependsOn.length ? `\n\n依赖需求:${req.dependsOn.join(', ')}` : ''
  const skill = getDevSkill(proj)
  const skillPrefix = skill ? `${skill} ` : ''
  const devPrompt = `${skillPrefix}${req.title}\n\n${req.content}${depNote}`
  // Register the pending→intent link so the resident `run:bound` subscription
  // flips the intent to `in_progress` and links the real dev session id
  // (ADR-0018 resident subs model).
  registerPendingDevLink(devId, req.id)
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
  // Guard: reject illegal status transitions.
  if (!canTransition(req.status, msg.status)) {
    conn.send({
      type: 'error',
      error: {
        code: 'intent.illegalStatusTransition',
        params: { from: req.status, to: msg.status },
      },
    })
    return
  }
  const prevStatus = req.status
  updateStatus(msg.intentId, msg.status)
  // If the intent leaves in_progress, clear its cache entry so a future
  // restart doesn't show a stale dangling/running label.
  if (req.status === 'in_progress' && msg.status !== 'in_progress') {
    clearRunStatus(msg.intentId)
    clearJudgedSession(msg.intentId)
  }
  // Publish domain event for cross-feature subscribers (ADR-0018).
  ctx.eventBus.publish('intent:status_changed', {
    intentId: msg.intentId,
    projectPath: req.projectPath,
    fromStatus: prevStatus,
    toStatus: msg.status,
  })
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

export const setIntentGitInfo: Handler<'set_intent_git_info'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const req = getIntent(msg.intentId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  if (msg.branchName !== undefined) setBranchName(msg.intentId, msg.branchName)
  if (msg.latestCommitHash !== undefined) setLatestCommitHash(msg.intentId, msg.latestCommitHash)
  if (msg.prId !== undefined && msg.prStatus !== undefined) {
    setPrInfo(msg.intentId, msg.prId, msg.prStatus)
  }
  ctx.broadcastIntents(req.projectPath)
}

export const updateIntentDepsHandler: Handler<'update_intent_deps'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const req = getIntent(msg.intentId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  updateIntentDeps(msg.intentId, msg.deps)
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

export const createPrHandler: Handler<'create_pr'> = async (ctx, conn, msg) => {
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
  // Only allow PR creation for done intents (completed but no PR yet).
  if (req.status !== 'done') {
    conn.send({
      type: 'error',
      error: {
        code: 'intent.prCreateFailed',
        params: { detail: `intent 状态为 ${req.status},需要 done` },
      },
    })
    return
  }
  if (req.prId) {
    conn.send({
      type: 'error',
      error: {
        code: 'intent.prCreateFailed',
        params: { detail: `intent 已有 PR #${req.prId}` },
      },
    })
    return
  }

  // Reuse the same PR creation logic as the orchestrator.
  const headBranch = req.branchName ?? undefined
  const bodyParts: string[] = [req.content]
  if (req.dependsOn.length > 0) {
    bodyParts.push('', '## 依赖需求')
    for (const depId of req.dependsOn) {
      const dep = getIntent(depId)
      const status = dep?.status ?? 'unknown'
      bodyParts.push(`- ${dep?.title ?? depId} (${status})`)
    }
  }
  const body = bodyParts.join('\n')
  const title = `feat: ${req.title}`

  try {
    const pr = await createGhPr(proj, title, body, headBranch)
    if (pr.ok && pr.prId) {
      setPrInfo(msg.intentId, pr.prId, 'reviewing')
      ctx.broadcastIntents(req.projectPath)
      conn.send({ type: 'create_pr_response', prId: pr.prId, prUrl: pr.prUrl ?? pr.prId })
    } else {
      conn.send({
        type: 'error',
        error: { code: 'intent.prCreateFailed', params: { detail: pr.error ?? '未知错误' } },
      })
    }
  } catch (err) {
    conn.send({
      type: 'error',
      error: {
        code: 'intent.prCreateFailed',
        params: { detail: err instanceof Error ? err.message : String(err) },
      },
    })
  }
}
