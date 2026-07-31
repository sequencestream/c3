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
  VENDOR_IDS,
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
import { canDeleteSession } from '../../kernel/agent/adapters/capabilities.js'
import { probeAll } from '../../kernel/agent/process/launcher.js'
import { loadHistory, loadLastAssistantMessages, removeSession } from '../../sessions.js'
import {
  getChatSession,
  getIntent,
  deleteIntentRecords,
  isStoreAvailable,
  listChatSessions,
  listIntentLogs,
  listIntentSessions as listIntentWorkSessions,
  listIntents,
  renameChatSession,
  deleteChatSession,
  createEmptyIntent,
  findIntentIdByAnySessionId,
  safeInsertIntentLog,
  setAutomate,
  setBranchName,
  setChatSession,
  setLatestCommitHash,
  setPrInfo,
  setIntentSessionId,
  updateIntent,
  updateIntentDeps,
  updateStatus,
} from './store.js'
import { clearPendingIntentLink, registerPendingIntentLink } from './intent-link.js'
import { buildResetIntentPrompt } from './reset-prompts.js'
import { reconcileInProgress } from './reconcile.js'
import { syncIntentPrStatus } from './pr-status-sync.js'
import { judgeCompletion } from './judge.js'
import {
  cacheRunStatus,
  enrichRunStatus,
  getJudgedSession,
  setJudgedSession,
} from './run-status.js'
import {
  forceSkipIntent,
  getQueueDetail,
  getWorkflowHooks,
  getWorkflowStatus,
  overrideIntentDecision,
  pauseWorkflow,
  resumeWorkflow,
  startWorkflow,
  stopWorkflow,
  unparkIntent,
} from './workflow.js'
import { getDiscussion } from '../discussions/store.js'
import { commitAndPush } from '../../git.js'
import { getWorktreePath, removeIntentGitResources } from './worktree.js'
import { resolveSpecFileAbs } from './specs-root.js'
import {
  deleteByVendorId,
  updateRealRowTitle,
  upsertBoundRow,
} from '../sessions/session-metadata-store.js'
import type { UiErrorCode } from '@ccc/shared/ui-codes.js'
import type { PromptImage, ServerToClient } from '@ccc/shared/protocol'
import type { KernelContext } from '../../kernel/types.js'
import type { Conn, Handler } from '../../transport/handler-registry.js'
import { launchWorkSession } from './session-launcher.js'
import { applyIntentStatusChange, createPrForIntent } from './write-cores.js'

export { buildResetIntentPrompt }

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

/**
 * Build the FIRST prompt of an intent-communication session: the target intent's
 * id/status/title/content preamble, the caller's user-input block, and the
 * in-place-update guard (`save_intents` must carry `id="<intentId>"` on exactly
 * one item; split-out items must not reuse it). Pure (no I/O) and the single
 * source of that guard wording — {@link startIntentSession} passes the user's
 * typed text, {@link discussionToIntent} a block built from the discussion title
 * + conclusion — so the two call sites cannot drift apart.
 */
export function buildIntentSessionFirstPrompt(intent: Intent, userInput: string): string {
  return `继续完善已存在意图 ${intent.id}(当前状态:${intent.status})。这是本轮唯一允许原地更新的目标。标题:${intent.title}。当前内容:${intent.content}\n\n用户输入:\n${userInput}\n\n定稿前先查询相关意图。调用 save_intents 时批次必须恰好一项携带 id="${intent.id}"；拆分出的其他项不得使用该 id。`
}

/**
 * Create → bind → launch an intent-communication session **owned by `intent`**:
 * a fresh `pending:` intent runtime bound to the intent agent, persisted as a
 * chat session, projected with this intent as owner, written onto the intent as
 * `intentSessionId`, and registered as a pending→intent link so the resident
 * `run:bound` subscription rewrites that id to the real session id on first
 * bind. Replies `session_selected` (empty history) + a refreshed intent list,
 * then launches the first run.
 *
 * On failure the session is unwound (link, runtime, chat row, `intent_session_id`)
 * and `intent.startSessionFailed` reported, but the **intent is left in place**.
 * Shared by {@link startIntentSession} and {@link discussionToIntent} so the
 * binding sequence exists once.
 */
async function bindAndLaunchIntentSession(
  ctx: KernelContext,
  conn: Conn,
  input: {
    proj: string
    intent: Intent
    /** Session (display) title — the intent title, or the discussion's for the bridge. */
    title: string
    prompt: string
    images?: PromptImage[]
  },
): Promise<void> {
  const { proj, intent, title } = input
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  try {
    if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
    const rt = ensureRuntime(chatId, proj, 'default', [], 'intent')
    bindIntentAgent(chatId)
    setChatSession(proj, chatId, title)
    syncIntentSessionProjection({
      workspacePath: proj,
      sessionId: chatId,
      title,
      ownerId: intent.id,
    })
    setIntentSessionId(intent.id, chatId)
    registerPendingIntentLink(chatId, intent.id)
    conn.viewing = chatId
    addViewer(chatId, conn.deliver)
    conn.send({
      type: 'session_selected',
      workspaceId: pathToId(proj)!,
      sessionId: chatId,
      title,
      mode: 'default',
      history: [],
      status: 'idle',
      vendor: resolveSessionVendor(chatId),
      agentSwitch: agentSwitchFor(chatId),
    })
    ctx.broadcastIntents(proj)
    await ctx.launchRun(rt, input.prompt, input.images)
  } catch (err) {
    clearPendingIntentLink(chatId)
    removeRuntime(chatId)
    try {
      deleteChatSession(proj, chatId)
    } catch {
      /* no persisted chat */
    }
    setIntentSessionId(intent.id, null)
    conn.send({
      type: 'error',
      error: { code: 'intent.startSessionFailed', params: { detail: String(err) } },
    })
    ctx.broadcastIntents(proj)
  }
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

export const createIntent: Handler<'create_intent'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj || !hasWorkspace(proj)) {
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
    const intent = createEmptyIntent(proj, conn.subject ?? 'system')
    conn.send({ type: 'create_intent_result', workspaceId: pathToId(proj)!, intent })
    ctx.broadcastIntents(proj)
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'intent.createFailed', params: { detail: String(err) } },
    })
  }
}

export const startIntentSession: Handler<'start_intent_session'> = async (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  const intent = getIntent(msg.intentId)
  if (!proj || !intent || resolveWorkspaceRoot(intent.workspaceId) !== proj) {
    conn.send({ type: 'error', error: { code: intent ? 'workspace.unknown' : 'intent.notFound' } })
    return
  }
  if (!msg.text.trim() && (!msg.images || msg.images.length === 0)) return
  if (intent.intentSessionId) {
    conn.send({ type: 'error', error: { code: 'intent.sessionAlreadyBound' } })
    return
  }
  await bindAndLaunchIntentSession(ctx, conn, {
    proj,
    intent,
    title: intent.title,
    prompt: buildIntentSessionFirstPrompt(intent, msg.text),
    images: msg.images,
  })
}

export const openIntentSession: Handler<'open_intent_session'> = async (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj || !hasWorkspace(proj)) {
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

/**
 * `discussion_to_intent` handler — bridge a concluded discussion into the intent
 * ledger with the SAME two steps as the "add intent" path: first persist an empty
 * `draft` intent ({@link createEmptyIntent}, so the conversion is visible in the
 * list before the agent saves anything), then start an intent-communication
 * session **owned by that intent** whose first turn carries the discussion title
 * + conclusion ({@link bindAndLaunchIntentSession}). The created intent is echoed
 * as `create_intent_result` so the console selects it and lands on its
 * intent-session tab, exactly as after a manual creation.
 *
 * Rejections (missing / non-`completed` / conclusion-less discussion, unknown
 * workspace, unavailable store) all happen BEFORE the intent is created, so a
 * refused conversion leaves nothing behind. A failed launch keeps the intent
 * (the session is unwound) — the user cancels or deletes it by hand.
 */
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
  // Step 1 — the placeholder intent, created exactly like `create_intent` does
  // (title `new intent`, P2, draft, empty content) so both paths share one
  // creation primitive and the ledger shows the conversion straight away.
  let intent: Intent
  try {
    intent = createEmptyIntent(proj, conn.subject ?? 'system')
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'intent.createFailed', params: { detail: String(err) } },
    })
    return
  }
  conn.send({ type: 'create_intent_result', workspaceId: pathToId(proj)!, intent })
  // Step 2 — bind an intent-owned comm session to it, seeded with the conclusion.
  // The session keeps the discussion title so it stays recognizable in the list.
  const userInput = `基于以下讨论结论拆分出可验证的需求条目。\n讨论:${discussion.title}\n结论:${discussion.conclusion}`
  await bindAndLaunchIntentSession(ctx, conn, {
    proj,
    intent,
    title: discussion.title,
    prompt: buildIntentSessionFirstPrompt(intent, userInput),
  })
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

/**
 * Delete one session's native transcript, dispatched on the session's REAL
 * vendor. Only a vendor whose session store reports a delete ability owns a
 * transcript c3 may remove; Codex reports `none`, so its JSONL under
 * `~/.codex/sessions/` stays on disk and c3 drops just its own references.
 * Handing a Codex session id to the Claude SDK is what raised
 * "Session not found" and aborted the whole intent delete.
 *
 * Failures are swallowed (logged): a transcript that is already gone — or any
 * other vendor-store hiccup — must not stop c3 from dropping the session's own
 * records.
 */
async function removeSessionTranscript(
  vendor: VendorId,
  workspacePath: string,
  sessionId: string,
): Promise<void> {
  if (!canDeleteSession(vendor)) return
  try {
    // Claude is the only delete-capable vendor today; `removeSession` is its
    // store's implementation. A future delete-capable vendor dispatches here.
    if (vendor === 'claude') await removeSession(workspacePath, sessionId)
  } catch (err) {
    warnSessionCleanup(sessionId, 'transcript 删除', err)
  }
}

/** One line per swallowed cleanup failure, naming the step that gave up. */
function warnSessionCleanup(sessionId: string, step: string, err: unknown): void {
  console.warn(
    `[c3:intent] 会话清理步骤失败，继续后续清理: ${step} ${sessionId} — ${err instanceof Error ? err.message : String(err)}`,
  )
}

/**
 * Run one step of a session's teardown behind its own fence. Each step is
 * independent because the intent's own records are deleted unconditionally
 * afterwards: a step that throws must not skip the steps behind it, or c3 keeps
 * session rows pointing at an intent that no longer exists — orphans the user
 * can neither see nor clean up.
 */
function fenceSessionCleanup(sessionId: string, step: string, run: () => void): void {
  try {
    run()
  } catch (err) {
    warnSessionCleanup(sessionId, step, err)
  }
}

export const deleteIntent: Handler<'delete_intent'> = async (ctx, conn, msg) => {
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
  if (!intent || resolveWorkspaceRoot(intent.workspaceId) !== proj) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }

  const sessionIds = new Set<string>()
  if (intent.intentSessionId) sessionIds.add(intent.intentSessionId)
  if (intent.specSessionId) sessionIds.add(intent.specSessionId)
  for (const session of listIntentWorkSessions(intent.id)) sessionIds.add(session.sessionId)

  for (const sessionId of sessionIds) {
    // Cleanup is best-effort and fenced step by step, not per session: one step
    // that refuses to run must strand neither the session's own c3 rows nor the
    // intent's db records and git resources (the human would be stuck retrying a
    // delete that always fails, or left with rows pointing at a deleted intent).
    let vendor: VendorId | null = null
    try {
      vendor = resolveSessionVendor(sessionId)
    } catch (err) {
      warnSessionCleanup(sessionId, '供应商解析', err)
    }
    // Remove runtime (abort + drop) BEFORE the db row so no stale runtime lingers.
    fenceSessionCleanup(sessionId, '运行时移除', () => removeRuntime(sessionId))
    if (vendor) await removeSessionTranscript(vendor, proj, sessionId)
    fenceSessionCleanup(sessionId, '沟通会话行删除', () => deleteChatSession(proj, sessionId))
    // Vendor unresolved: sweep every vendor's projection key, since the row is
    // keyed by (vendor, sessionId) and must not outlive the intent either way.
    for (const v of vendor ? [vendor] : VENDOR_IDS)
      fenceSessionCleanup(sessionId, '会话投影删除', () => deleteByVendorId(v, sessionId))
    if (conn.viewing === sessionId) conn.viewing = null
  }

  try {
    removeIntentGitResources(proj, intent.id, intent.branchName)
    deleteIntentRecords(intent.id)
    ctx.broadcastIntents(proj)
    ctx.broadcastIntentSessions(proj)
    ctx.broadcastStatuses()
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'intent.deleteFailed', params: { detail: String(err) } },
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
  const proj = resolveWorkspaceRoot(getIntent(msg.intentId)?.workspaceId ?? '')
  if (!isStoreAvailable() || !proj) {
    conn.send({
      type: 'error',
      error: { code: isStoreAvailable() ? 'intent.notFound' : 'intent.dbUnavailable' },
    })
    return
  }
  const result = await applyIntentStatusChange(proj, msg.intentId, msg.status, {
    broadcastIntents: ctx.broadcastIntents,
    publishStatusChanged: (input) => ctx.eventBus.publish('intent:status_changed', input),
    actor: conn.subject,
  })
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
    // Judged against the PRE-update intent: only a first-time association logs.
    // Overwriting an existing prId, or a status-only update, records nothing —
    // the changelog tracks when the PR appeared, not every later edit.
    const firstAssociation = !req.prId && !!msg.prId
    setPrInfo(msg.intentId, msg.prId, msg.prStatus)
    if (firstAssociation) {
      safeInsertIntentLog(
        msg.intentId,
        'pr_created',
        `创建 PR #${msg.prId}`,
        conn.subject ?? 'system',
      )
    }
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

/** Build the wire projection of a workspace queue's per-intent detail. */
function queueDetailFrame(workspacePath: string, workspaceId: string): ServerToClient {
  const detail = getQueueDetail(workspacePath)
  const byId = new Map(listIntents(workspacePath).map((r) => [r.id, r]))
  return {
    type: 'queue_detail',
    detail: {
      workspaceId,
      state: detail.state,
      tickId: detail.tickId,
      nextWakeupAt: detail.nextWakeupAt,
      items: detail.items.map((item) => {
        const req = byId.get(item.intentId)
        return {
          ...item,
          status: req?.status ?? 'todo',
          priority: req?.priority ?? 'P2',
        }
      }),
    },
  }
}

export const getQueueDetailHandler: Handler<'get_queue_detail'> = (_ctx, conn, msg) => {
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
  conn.send(queueDetailFrame(proj, msg.workspaceId))
}

/**
 * Manual queue control. Every action maps onto exactly one kernel action; the
 * server validates the workspace, the intent and the transition, and refuses
 * anything that would need a hard gate to be bypassed. A refusal is always
 * reported — a control that silently did nothing would read as success.
 */
export const queueControlHandler: Handler<'queue_control'> = (ctx, conn, msg) => {
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

  const perIntent =
    msg.action === 'force_skip' ||
    msg.action === 'unskip' ||
    msg.action === 'unpark' ||
    msg.action === 'override_continue' ||
    msg.action === 'override_block'
  if (perIntent) {
    if (!msg.intentId) {
      conn.send({ type: 'error', error: { code: 'queue.intentRequired' } })
      return
    }
    const req = getIntent(msg.intentId)
    if (!req || resolveWorkspaceRoot(req.workspaceId) !== proj) {
      conn.send({ type: 'error', error: { code: 'intent.notFound' } })
      return
    }
  }

  switch (msg.action) {
    case 'pause':
      ctx.broadcastWorkflow(pauseWorkflow(proj))
      break
    case 'resume':
      ctx.broadcastWorkflow(resumeWorkflow(proj))
      break
    case 'force_skip':
      forceSkipIntent(proj, msg.intentId!, true)
      break
    case 'unskip':
      forceSkipIntent(proj, msg.intentId!, false)
      break
    case 'unpark':
      if (!unparkIntent(proj, msg.intentId!)) {
        conn.send({ type: 'error', error: { code: 'queue.notParked' } })
        return
      }
      break
    case 'override_continue':
    case 'override_block': {
      const decision = msg.action === 'override_continue' ? 'continue' : 'block'
      const actor = conn.subject ?? 'user'
      if (!overrideIntentDecision(proj, msg.intentId!, decision, actor)) {
        conn.send({ type: 'error', error: { code: 'queue.overrideNotApplicable' } })
        return
      }
      break
    }
  }
  conn.send(queueDetailFrame(proj, msg.workspaceId))
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
  const result = await createPrForIntent(proj, msg.intentId, {
    broadcastIntents: ctx.broadcastIntents,
    normalizeEvent: ctx.normalizeEvent,
    publishEvent: (workspacePath, sessionId, event) =>
      ctx.eventBus.publish('event', { workspacePath, sessionId, event }),
    actor: conn.subject,
  })
  if (!result.success) {
    conn.send({
      type: 'error',
      error: {
        code: result.code as UiErrorCode,
        ...(result.params ? { params: result.params } : {}),
      },
    })
    return
  }
  conn.send({ type: 'create_pr_response', prId: result.prId, prUrl: result.prUrl })
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
