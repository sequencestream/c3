/**
 * `intents` feature handlers — slice 1/3 (ADR-0009).
 *
 * Intent ledger view: list, comm-session open/new/refine, dev launch,
 * status/automation toggles, and the automation orchestrator start/stop. The
 * runStatus cache + judged-sessions de-dup live in `./run-status`; the automation
 * hooks bag in `./automation` (both feature-private). Cross-feature services
 * (launcher, broadcasts) are reached via `ctx`; per-connection delivery via `conn`.
 */
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  PENDING_SESSION_PREFIX,
  type DevLaunchStage,
  type Intent,
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
import { hasWorkspace, resolveWorkspaceRoot, pathToId, touchWorkspace } from '../../state.js'
import { getDefaultMode, getGitBranchMode, getSddEnabled } from '../../kernel/config/index.js'
import {
  resolveIntentAgent,
  resolveSessionAgentSwitch,
  resolveSessionVendor,
  resolveSpecAgent,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
import { probeAll } from '../../kernel/agent/process/launcher.js'
import { loadHistory, loadLastAssistantMessages } from '../../sessions.js'
import {
  canTransition,
  getChatSession,
  getIntent,
  isStoreAvailable,
  listChatSessions,
  listIntentLogs,
  listIntents,
  renameChatSession,
  deleteChatSession,
  findIntentIdByAnySessionId,
  safeInsertIntentLog,
  setAutomate,
  setBranchName,
  setChatSession,
  setLatestCommitHash,
  setPrInfo,
  updateIntent,
  updateIntentDeps,
  updateStatus,
} from './store.js'
import { clearPendingIntentLink, registerPendingIntentLink } from './intent-link.js'
import { reconcileInProgress } from './reconcile.js'
import { publishIntentStatusTransition } from './lifecycle-events.js'
import { normalizeBranchName } from './dependency-gate.js'
import { syncIntentPrStatus } from './pr-status-sync.js'
import { judgeCompletion } from './judge.js'
import {
  cacheRunStatus,
  clearJudgedSession,
  clearRunStatus,
  enrichRunStatus,
  getJudgedSession,
  setJudgedSession,
} from './run-status.js'
import { getWorkflowHooks, getWorkflowStatus, startWorkflow, stopWorkflow } from './workflow.js'
import { getDiscussion } from '../discussions/store.js'
import { closeForgePr, commitAndPush, createGhPr, hasCommittableChanges } from '../../git.js'
import { runServerSidePrCreate } from '../pr-events/tool-defs.js'
import { getWorktreePath } from './worktree.js'
import { resolveSpecFileAbs } from './specs-root.js'
import {
  deleteByVendorId,
  updateRealRowTitle,
  upsertBoundRow,
} from '../sessions/session-metadata-store.js'
import type { UiErrorCode } from '@ccc/shared/ui-codes.js'
import type { Handler } from '../../transport/handler-registry.js'
import { launchWorkSession } from './session-launcher.js'

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
 * Bind the **intent agent** to a newly-created intent comm session (pending id).
 * Resolves `intentAgentId` through {@link resolveIntentAgent} (empty ⇒ follow the
 * default agent: `intentAgentId → defaultAgentId → system`), so intent-communication
 * sessions can run on a stronger/decoupled agent than "default for new sessions".
 * Must be called after `ensureRuntime` so `resolveSessionLaunch`/agent switcher
 * find the pending intent in later lookups.
 */
function bindIntentAgent(sessionId: string): void {
  setSessionAgent(sessionId, resolveIntentAgent().id)
}

function syncIntentSessionProjection(input: {
  workspacePath: string
  sessionId: string
  title: string
  ownerId?: string | null
}): void {
  const ownerId = input.ownerId ?? findIntentIdByAnySessionId(input.sessionId)
  const agent = resolveIntentAgent()
  upsertBoundRow({
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    vendor: resolveSessionVendor(input.sessionId),
    agentId: agent.id,
    title: input.title,
    sessionKind: 'intent',
    ownerKind: ownerId ? 'intent' : null,
    ownerId,
  })
}

// ---- Handlers ----

export const listIntentsHandler: Handler<'list_intents'> = (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  conn.send({
    type: 'intents',
    workspaceId: pathToId(proj)!,
    items: listIntents(proj, msg.status),
    sddEnabled: getSddEnabled(proj),
  })
}

export const openIntentSession: Handler<'open_intent_session'> = async (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!hasWorkspace(proj)) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
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
      bindIntentAgent(chatId)
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
        bindIntentAgent(chatId)
      }
    } else {
      chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
      ensureRuntime(chatId, proj, 'default', [], 'intent')
      bindIntentAgent(chatId)
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
  syncIntentSessionProjection({ workspacePath: proj, sessionId: chatId, title: realTitle })
  conn.send({
    type: 'session_selected',
    workspaceId: pathToId(proj)!,
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
  // (enrichRunStatus); the expensive part — judging dead work sessions — runs in
  // the background below and re-broadcasts the refreshed list once it settles.
  conn.send({
    type: 'intents',
    workspaceId: pathToId(proj)!,
    items: enrichRunStatus(listIntents(proj)),
    sddEnabled: getSddEnabled(proj),
  })
  conn.send({ type: 'workflow_status', status: getWorkflowStatus(proj) })

  // Reconcile in_progress intents in the background: for each, check
  // liveness and auto-complete if the process is dead but the judge confirms
  // done. Never blocks the list send above.
  const inProgReqs = listIntents(proj).filter((r) => r.status === 'in_progress')
  // (B) Skip a intent whose CURRENT dead session was already judged (same
  // verdict, saved LLM call). Live processes and brand-new session ids fall
  // through and still get (re)judged.
  const toReconcile = inProgReqs.filter((r) => {
    const dead = !(r.lastWorkSessionId && isRunning(r.lastWorkSessionId))
    if (!dead) return true
    return !r.lastWorkSessionId || getJudgedSession(r.id) !== r.lastWorkSessionId
  })
  if (toReconcile.length > 0) {
    const signal = new AbortController()
    const sessionById = new Map(inProgReqs.map((r) => [r.id, r.lastWorkSessionId]))
    void reconcileInProgress(
      toReconcile,
      proj,
      {
        isRunning,
        getGitBranchMode,
        getWorktreePath,
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

/**
 * Open an intent's spec-authoring session (`spec_session_id`) for read-only
 * viewing in the detail's `spec session` tab. Mirrors {@link openIntentSession}'s
 * runtime-restore path but for the `'spec'` kind: if the runtime was dropped
 * (process restart / GC), reload its transcript, re-confine writes to the spec
 * directory, and re-pin the spec agent. No intents list / reconcile side-effects.
 */
export const openSpecSession: Handler<'open_spec_session'> = async (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const intent = getIntent(msg.intentId)
  if (!intent) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  const chatId = intent.specSessionId
  if (!chatId) {
    conn.send({
      type: 'error',
      error: { code: 'intent.chatSessionNotFound', params: { sessionId: '' } },
    })
    return
  }
  // Stop viewing whatever this connection had open.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  if (!getRuntime(chatId)) {
    const isPending = chatId.startsWith(PENDING_SESSION_PREFIX)
    const baseline = isPending ? [] : await loadHistory(proj, chatId).catch(() => [])
    const restored = ensureRuntime(chatId, proj, getDefaultMode(proj), baseline, 'spec')
    // Restore the write-confinement gate (writes limited to the spec directory)
    // and re-pin the spec agent so a reopened spec session keeps its identity.
    // The stored spec path is absolute (centralized root, outside the workspace).
    if (intent.specPath) restored.specDir = dirname(resolveSpecFileAbs(proj, intent.specPath))
    const specAgent = resolveSpecAgent()
    setSessionAgent(chatId, specAgent.id)
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
    workspaceId: pathToId(proj)!,
    sessionId: chatId,
    title: intent.title,
    mode: rt.mode,
    history: rt.baseline,
    status: rt.status,
    vendor: resolveSessionVendor(chatId),
    agentSwitch: agentSwitchFor(chatId),
  })
  for (const e of rt.buffer) conn.send(e)
  addViewer(chatId, conn.deliver)
}

export const newIntentSession: Handler<'new_intent_session'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  // Open a brand-new comm session: setChatSession resets the prior is_current
  // row to 0 and marks this one current, so a refresh / reconnect via
  // open_intent_session resumes THIS session.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'intent')
  bindIntentAgent(chatId)
  setChatSession(proj, chatId)
  syncIntentSessionProjection({ workspacePath: proj, sessionId: chatId, title: 'New Intent' })
  conn.viewing = chatId
  touchWorkspace(proj, Date.now())
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspaceId: pathToId(proj)!,
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
    workspaceId: pathToId(proj)!,
    items: enrichRunStatus(listIntents(proj)),
    sddEnabled: getSddEnabled(proj),
  })
  conn.send({ type: 'workflow_status', status: getWorkflowStatus(proj) })
}

export const refineIntent: Handler<'refine_intent'> = async (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
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
  // Restart the comm session as a fresh one seeded with this intent.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'intent')
  bindIntentAgent(chatId)
  setChatSession(proj, chatId, req.title)
  syncIntentSessionProjection({
    workspacePath: proj,
    sessionId: chatId,
    title: req.title,
    ownerId: req.id,
  })
  conn.viewing = chatId
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspaceId: pathToId(proj)!,
    sessionId: chatId,
    title: req.title,
    mode: 'default',
    history: [],
    status: 'idle',
    vendor: resolveSessionVendor(chatId),
    agentSwitch: agentSwitchFor(chatId),
  })
  conn.send({
    type: 'intents',
    workspaceId: pathToId(proj)!,
    items: listIntents(proj),
    sddEnabled: getSddEnabled(proj),
  })
  // Link the pending refine session to this intent so the resident `run:bound`
  // subscription backfills `intent_session_id` onto the intent on first bind,
  // making the comm/refine conversation reopenable from the intent detail.
  registerPendingIntentLink(chatId, req.id)
  const firstPrompt = `开始完善已存在意图 ${req.id}(当前状态:${req.status})。标题:${req.title}。当前内容:${req.content}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_intents 并在该条目上回填 id="${req.id}" 以原地更新原意图(切勿新建重复项)。若该意图已处于 in_progress 或 done 则无法修改,请告知我。`
  try {
    await ctx.launchRun(rt, firstPrompt)
  } catch (err) {
    clearPendingIntentLink(chatId)
    throw err
  }
}

/**
 * Build the first prompt for a RESET intent (refine/comm) session — a fresh
 * session seeded with the user's new steering input concatenated with the
 * intent's current content. Pure (no I/O) so the concatenation is unit-testable.
 * Chinese skeleton, mirroring {@link refineIntent}'s seed.
 */
export function buildResetIntentPrompt(intent: Intent, userInput: string): string {
  const steer = userInput.trim()
  const steerBlock = steer ? `我的新输入:\n${steer}\n\n` : ''
  return `继续完善已存在意图 ${intent.id}(当前状态:${intent.status})。\n\n${steerBlock}意图标题:${intent.title}\n当前意图内容:\n${intent.content}\n\n请结合上面的新输入与意图内容,与我确认拆解/补充,定稿后调用 save_intents 并在该条目上回填 id="${intent.id}" 以原地更新原意图(切勿新建重复项)。若该意图已处于 in_progress 或 done 则无法修改,请告知我。`
}

/**
 * `reset_intent_session` handler — start a FRESH comm/refine session seeded with
 * the user's new input + the intent's current content, replacing the prior
 * `intent_session_id` (re-linked on first bind via the resident `run:bound`
 * subscription). The escape hatch for a context-rotted refine conversation after
 * the intent changed. Mirrors {@link refineIntent} but injects the user's steering
 * input ahead of the intent content.
 */
export const resetIntentSession: Handler<'reset_intent_session'> = async (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
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
  // Restart the comm session as a fresh one seeded with this intent + new input.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'intent')
  bindIntentAgent(chatId)
  setChatSession(proj, chatId, req.title)
  syncIntentSessionProjection({
    workspacePath: proj,
    sessionId: chatId,
    title: req.title,
    ownerId: req.id,
  })
  conn.viewing = chatId
  touchWorkspace(proj, Date.now())
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspaceId: pathToId(proj)!,
    sessionId: chatId,
    title: req.title,
    mode: 'default',
    history: [],
    status: 'idle',
    vendor: resolveSessionVendor(chatId),
    agentSwitch: agentSwitchFor(chatId),
  })
  conn.send({
    type: 'intents',
    workspaceId: pathToId(proj)!,
    items: listIntents(proj),
    sddEnabled: getSddEnabled(proj),
  })
  // Link the pending refine session to this intent so the resident `run:bound`
  // subscription replaces `intent_session_id` with the real comm session id on
  // first bind, making the new conversation reopenable from the intent detail.
  registerPendingIntentLink(chatId, req.id)
  try {
    await ctx.launchRun(rt, buildResetIntentPrompt(req, msg.userInput))
  } catch (err) {
    clearPendingIntentLink(chatId)
    throw err
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
  const proj = resolveWorkspaceRoot(discussion.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: discussion.workspaceId } },
    })
    return
  }
  // Seed a fresh comm session with the conclusion — a refine variant.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, proj, 'default', [], 'intent')
  bindIntentAgent(chatId)
  setChatSession(proj, chatId, discussion.title)
  syncIntentSessionProjection({ workspacePath: proj, sessionId: chatId, title: discussion.title })
  conn.viewing = chatId
  addViewer(chatId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspaceId: pathToId(proj)!,
    sessionId: chatId,
    title: discussion.title,
    mode: 'default',
    history: [],
    status: 'idle',
    vendor: resolveSessionVendor(chatId),
    agentSwitch: agentSwitchFor(chatId),
  })
  conn.send({
    type: 'intents',
    workspaceId: pathToId(proj)!,
    items: listIntents(proj),
    sddEnabled: getSddEnabled(proj),
  })
  const firstPrompt = `基于以下讨论结论拆分出可验证的需求条目。讨论:${discussion.title}。结论:${discussion.conclusion}。请阅读相关项目资料后,与我确认拆解/补充,定稿后调用 save_intents。`
  await ctx.launchRun(rt, firstPrompt)
}

// ── Intent-communication-session CRUD (session-collection upgrade) ──

export const listIntentSessions: Handler<'list_intent_sessions'> = (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
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
    workspaceId: pathToId(proj)!,
    items,
    runStates: found ? runStates : undefined,
  })
}

export const renameIntentSession: Handler<'rename_intent_session'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  try {
    renameChatSession(msg.sessionId, msg.title)
    updateRealRowTitle(msg.sessionId, resolveSessionVendor(msg.sessionId), msg.title)
    ctx.broadcastIntentSessions(proj)
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'intent.renameChatSessionFailed', params: { detail: String(err) } },
    })
  }
}

export const deleteIntentSession: Handler<'delete_intent_session'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  try {
    // Remove runtime (abort + drop) BEFORE the db row so no stale runtime lingers.
    removeRuntime(msg.sessionId)
    deleteChatSession(proj, msg.sessionId)
    deleteByVendorId(resolveSessionVendor(msg.sessionId), msg.sessionId)
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
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  const result = await launchWorkSession(
    proj,
    msg.intentId,
    { launchRun: ctx.launchRun, broadcastIntents: ctx.broadcastIntents },
    (stage) =>
      conn.send({
        type: 'dev_launch_progress',
        intentId: msg.intentId,
        stage: stage as DevLaunchStage,
      }),
    conn.subject,
  )
  if (!result.success) {
    conn.send({
      type: 'error',
      error: {
        code: result.code as UiErrorCode,
        ...(result.params ? { params: result.params } : {}),
      },
    })
  }
}

export const updateIntentStatus: Handler<'update_intent_status'> = async (ctx, conn, msg) => {
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
  // Cancelling an intent that owns a PR closes the remote PR first. This runs
  // synchronously ahead of the status flip: a close failure (CLI missing, auth,
  // or a PR already closed externally) blocks the cancellation entirely — the
  // intent keeps its status and the user handles it on the forge before retrying.
  if (msg.status === 'cancelled' && req.prId) {
    const proj = resolveWorkspaceRoot(req.workspaceId)!
    const close = await closeForgePr(proj, req.prId)
    if (!close.ok) {
      conn.send({
        type: 'error',
        error: { code: 'intent.prCloseFailed', params: { detail: close.error ?? '未知错误' } },
      })
      return
    }
  }
  const prevStatus = req.status
  // UI-initiated transition: the lifecycle log's actor is the login subject.
  updateStatus(msg.intentId, msg.status, conn.subject ?? 'system')
  // PR closed alongside the cancellation: flip its lifecycle status to `closed`
  // (keeping the existing pr_url) and record the audit log. `updateStatus` already
  // wrote the `status_changed` entry, so this only adds the `pr_closed` entry.
  if (msg.status === 'cancelled' && req.prId) {
    setPrInfo(msg.intentId, req.prId, 'closed', req.prUrl ?? null)
    safeInsertIntentLog(
      msg.intentId,
      'pr_closed',
      `PR #${req.prId} 已随意图取消`,
      conn.subject ?? 'system',
    )
  }
  // If the intent leaves in_progress, clear its cache entry so a future
  // restart doesn't show a stale dangling/running label.
  if (req.status === 'in_progress' && msg.status !== 'in_progress') {
    clearRunStatus(msg.intentId)
    clearJudgedSession(msg.intentId)
  }
  // Publish domain event for cross-feature subscribers (ADR-0018).
  ctx.eventBus.publish('intent:status_changed', {
    intentId: msg.intentId,
    workspacePath: resolveWorkspaceRoot(req.workspaceId)!,
    fromStatus: prevStatus,
    toStatus: msg.status,
  })
  publishIntentStatusTransition(resolveWorkspaceRoot(req.workspaceId)!, req, prevStatus, msg.status)
  ctx.broadcastIntents(resolveWorkspaceRoot(req.workspaceId)!)
}

/**
 * `update_intent_content` handler — the human inline-edit entry for an intent's
 * markdown body. Only `draft` / `todo` intents may be edited; every other status
 * (in_progress / done / cancelled / blocked / failed …) is rejected here so the
 * client-side button hiding is never the only gate. On success it updates only
 * `content` (+ `updated_at`), appends one `intent_updated` log (simple summary,
 * no before/after diff), re-broadcasts the intents list so the detail refills,
 * and re-sends this intent's `intent_logs_list` so an already-open changelog tab
 * picks up the new row.
 */
export const updateIntentContent: Handler<'update_intent_content'> = (ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const req = getIntent(msg.intentId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  if (req.status !== 'draft' && req.status !== 'todo') {
    conn.send({
      type: 'error',
      error: { code: 'intent.contentEditForbidden', params: { status: req.status } },
    })
    return
  }
  updateIntent(msg.intentId, { content: msg.content })
  safeInsertIntentLog(msg.intentId, 'intent_updated', '更新意图正文', conn.subject ?? 'system')
  const proj = resolveWorkspaceRoot(req.workspaceId)!
  ctx.broadcastIntents(proj)
  // Refresh the per-intent changelog cache for a changelog tab that was already
  // opened before this edit (it would otherwise keep stale logs until reselected).
  conn.send({
    type: 'intent_logs_list',
    intentId: msg.intentId,
    items: listIntentLogs(msg.intentId),
  })
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
  ctx.broadcastIntents(resolveWorkspaceRoot(req.workspaceId)!)
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
  ctx.broadcastIntents(resolveWorkspaceRoot(req.workspaceId)!)
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
  ctx.broadcastIntents(resolveWorkspaceRoot(req.workspaceId)!)
}

export const startWorkflowHandler: Handler<'start_workflow'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  ctx.broadcastWorkflow(startWorkflow(proj, getWorkflowHooks(), Date.now()))
}

export const stopWorkflowHandler: Handler<'stop_workflow'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  ctx.broadcastWorkflow(stopWorkflow(proj))
}

export const createPrHandler: Handler<'create_pr'> = async (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
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
  // Idempotent guard first: an intent that already has a PR is never re-created —
  // no Git checks, no commit, no push. Independent of intent status.
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
  // Manual PR creation no longer reads intent status; it serves the isolated
  // worktree only, and requires a branch plus committable changes. Fixed order:
  // worktree mode → non-empty branch → worktree has committable changes.
  if (getGitBranchMode(proj) !== 'worktree') {
    conn.send({ type: 'error', error: { code: 'intent.prCreateNotWorktree' } })
    return
  }
  if (normalizeBranchName(req.branchName) === null) {
    conn.send({ type: 'error', error: { code: 'intent.prCreateNoBranch' } })
    return
  }
  const worktreePath = getWorktreePath(proj, msg.intentId)
  if (!(await hasCommittableChanges(worktreePath))) {
    conn.send({ type: 'error', error: { code: 'intent.prCreateNoChanges' } })
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
    // Commit and push the worktree's changes first (same helper the orchestrator
    // uses); only create the PR when the commit/push succeeded.
    const commit = await commitAndPush(worktreePath, title)
    if (!commit.ok) {
      conn.send({
        type: 'error',
        error: { code: 'intent.prCreateFailed', params: { detail: commit.error ?? '提交失败' } },
      })
      return
    }
    const pr = await createGhPr(worktreePath, title, body, headBranch)
    if (pr.ok && pr.prId) {
      setPrInfo(msg.intentId, pr.prId, 'reviewing', pr.prUrl ?? null)
      safeInsertIntentLog(msg.intentId, 'pr_created', `创建 PR #${pr.prId}`, conn.subject)
      ctx.broadcastIntents(resolveWorkspaceRoot(req.workspaceId)!)
      conn.send({ type: 'create_pr_response', prId: pr.prId, prUrl: pr.prUrl ?? pr.prId })

      // Publish a pr:create event so event-triggered automations can react.
      runServerSidePrCreate(
        {
          prId: pr.prId,
          prUrl: pr.prUrl ?? null,
          headBranch,
          baseBranch: undefined,
          intentId: msg.intentId,
        },
        ctx.normalizeEvent,
        (event) =>
          ctx.eventBus.publish('event', {
            workspacePath: proj,
            sessionId: msg.intentId,
            event,
          }),
      )
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

/**
 * `list_intent_logs` handler — one intent's lifecycle-log entries for the
 * detail's changelog tab. Newest-first full fetch (no pagination); the intent
 * must exist (mirrors `update_intent_status`'s intent-scoped validation).
 */
export const listIntentLogsHandler: Handler<'list_intent_logs'> = (_ctx, conn, msg) => {
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const req = getIntent(msg.intentId)
  if (!req) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  conn.send({
    type: 'intent_logs_list',
    intentId: msg.intentId,
    items: listIntentLogs(msg.intentId),
  })
}

export const syncIntentPrStatusHandler: Handler<'sync_intent_pr_status'> = async (
  ctx,
  conn,
  msg,
) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const result = await syncIntentPrStatus({
    workspacePath: proj,
    intentId: msg.intentId,
    broadcastIntents: ctx.broadcastIntents,
  })
  conn.send({
    type: 'sync_intent_pr_status_response',
    workspaceId: msg.workspaceId,
    intentId: msg.intentId,
    ok: result.ok,
    prStatus: result.prStatus,
    changed: result.changed,
    message: result.message,
    error: result.error,
  })
}
