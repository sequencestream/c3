/**
 * `sessions` feature handlers — slice 1/3 (ADR-0009).
 *
 * The core session lifecycle: list/create/select/delete/rename, mode, stop, and
 * the user prompt launch. `(ctx, conn, msg)` signature; per-connection `viewing`
 * + delivery live on `conn`, shared services on `ctx`.
 */
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import {
  addViewer,
  emit,
  ensureRuntime,
  getRuntime,
  removeRuntime,
  removeViewer,
  setStatus,
  stopRun,
} from '../../runs.js'
import {
  getActiveSessionId,
  getSessionMode,
  hasWorkspace,
  setActiveSessionId,
  setSessionMode,
  touchWorkspace,
} from '../../state.js'
import { getDefaultMode, getSessionAgentId } from '../../kernel/config/index.js'
import {
  firstAgentForVendor,
  resolveAgent,
  resolveSessionAgentSwitch,
  resolveSessionVendor,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
import { probeAll } from '../../kernel/agent/process/launcher.js'
import { VENDOR_CAPABILITIES } from '../../kernel/agent/adapters/capabilities.js'
import type { SessionAgentSwitch, VendorId } from '@ccc/shared/protocol'
import { loadHistory, removeSession, renameWorkspaceSession, sessionTitle } from '../../sessions.js'
import { listCommands } from '../../commands.js'
import { rebindChatSession } from '../requirements/store.js'
import { upsertPendingRow } from './store.js'
import { errMsg } from '../errmsg.js'
import type { Handler } from '../../transport/handler-registry.js'

/** Vendors whose host CLI resolved on PATH (ADR-0012) — the switcher availability set. */
function presentVendorSet(): Set<VendorId> {
  return new Set(
    probeAll()
      .filter((p) => p.path !== null)
      .map((p) => p.vendor),
  )
}

/** The title-bar agent-switcher payload for a console session, or undefined (no switcher). */
function agentSwitchFor(sessionId: string): SessionAgentSwitch | undefined {
  return resolveSessionAgentSwitch(sessionId, presentVendorSet()) ?? undefined
}

export const listSessions: Handler<'list_sessions'> = async (_ctx, conn, msg) => {
  await conn.sendSessions(resolve(msg.workspacePath))
}

export const listCommandsHandler: Handler<'list_commands'> = async (_ctx, conn) => {
  const cwd = conn.viewing ? getRuntime(conn.viewing)?.workspacePath : null
  if (!cwd) {
    conn.send({ type: 'commands', commands: [] })
    return
  }
  try {
    const commands = await listCommands(cwd)
    conn.send({ type: 'commands', commands })
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'command.listFailed', params: { detail: errMsg(err) } },
    })
  }
}

export const createSession: Handler<'create_session'> = (_ctx, conn, msg) => {
  const abs = resolve(msg.workspacePath)
  if (!hasWorkspace(abs)) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { path: msg.workspacePath } },
    })
    return
  }
  // Switching views never stops a run — just stop watching the old one.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const pendingId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  // The pending intent (ADR-0015) now lives in the `session_metadata`
  // projection table as a `pending` row (F-11). The first run launches
  // with this agent and freezes its vendor on bind. The row is written
  // BEFORE `session_selected` is sent so a `list_sessions` immediately
  // after `create_session` (e.g. the sidebar refresh) sees the new row.
  //
  // The raw `agentId` is stored as the intent (not the resolved agent id)
  // — the same contract as the old `setPendingIntent` — so a future
  // `resolveSessionLaunch` re-resolves it at launch time. The vendor is
  // resolved from the agent registry for the pending row's display.
  const intentAgentId = msg.agentId || null
  const resolvedAgent = resolveAgent(intentAgentId)
  upsertPendingRow({
    pendingId,
    workspacePath: abs,
    vendor: resolvedAgent.vendor,
    agentId: intentAgentId ?? resolvedAgent.id,
  })
  const defaultMode = getDefaultMode()
  ensureRuntime(pendingId, abs, defaultMode, [])
  conn.viewing = pendingId
  addViewer(pendingId, conn.deliver)
  touchWorkspace(abs, Date.now())
  conn.send({
    type: 'session_selected',
    workspacePath: abs,
    sessionId: pendingId,
    title: 'New session',
    mode: defaultMode,
    history: [],
    status: 'idle',
    vendor: resolveSessionVendor(pendingId),
    // Pending sessions have no fact yet ⇒ no switcher (resolveSessionAgentSwitch null).
    agentSwitch: agentSwitchFor(pendingId),
  })
  conn.sendWorkspaces()
}

export const selectSession: Handler<'select_session'> = async (_ctx, conn, msg) => {
  const abs = resolve(msg.workspacePath)
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  try {
    const existing = getRuntime(msg.sessionId)
    // Resume-by-id of a session whose vendor cannot cold-load history (Codex:
    // `read: 'none'`). The `vendor` hint arrives only from the resume-by-id
    // placeholder — the projection/native store has never seen this id, so the
    // Claude-only `sessionTitle`/`loadHistory` below would throw → `openFailed`.
    // Skip them, seed an empty baseline, and bind the id to a vendor-matching
    // agent (when it has no fact yet) so the next turn resolves the right vendor
    // and `resume`s natively. Gate by capability *state*, never vendor identity.
    const resumeByIdVendor =
      !existing && msg.vendor && VENDOR_CAPABILITIES[msg.vendor].sessions.read === 'none'
        ? msg.vendor
        : null
    if (resumeByIdVendor && !getSessionAgentId(msg.sessionId)) {
      const agent = firstAgentForVendor(resumeByIdVendor)
      if (!agent) {
        conn.send({
          type: 'error',
          error: { code: 'session.resumeNoAgent', params: { vendor: resumeByIdVendor } },
        })
        return
      }
      setSessionAgent(msg.sessionId, agent.id)
    }
    // The pasted id is the only honest title we have for a not-yet-run resume;
    // the projection overwrites it with the native title on the first run end.
    const title = resumeByIdVendor ? msg.sessionId : await sessionTitle(abs, msg.sessionId)
    // Cold session ⇒ read disk once and seed a runtime; warm session ⇒
    // reuse its in-memory runtime (baseline + live buffer). After this
    // point there is no `await`, so the replay below is atomic w.r.t.
    // concurrent `emit`s.
    const rt = existing
      ? existing
      : ensureRuntime(
          msg.sessionId,
          abs,
          getSessionMode(msg.sessionId),
          resumeByIdVendor ? [] : await loadHistory(abs, msg.sessionId),
        )
    conn.viewing = msg.sessionId
    touchWorkspace(abs, Date.now())
    setActiveSessionId(msg.sessionId)
    conn.send({
      type: 'session_selected',
      workspacePath: abs,
      sessionId: msg.sessionId,
      title,
      mode: rt.mode,
      history: rt.baseline,
      status: rt.status,
      vendor: resolveSessionVendor(msg.sessionId),
      agentSwitch: agentSwitchFor(msg.sessionId),
    })
    // Replay everything emitted since the baseline (current + past
    // turns), then start receiving live events.
    for (const e of rt.buffer) conn.send(e)
    addViewer(msg.sessionId, conn.deliver)
    conn.sendWorkspaces()
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'session.openFailed', params: { detail: errMsg(err) } },
    })
  }
}

export const deleteSession: Handler<'delete_session'> = async (ctx, conn, msg) => {
  const abs = resolve(msg.workspacePath)
  try {
    removeRuntime(msg.sessionId)
    await removeSession(abs, msg.sessionId)
    if (conn.viewing === msg.sessionId) conn.viewing = null
    if (getActiveSessionId() === msg.sessionId) setActiveSessionId(null)
    await conn.sendSessions(abs)
    ctx.broadcastStatuses()
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'session.deleteFailed', params: { detail: errMsg(err) } },
    })
  }
}

export const renameSession: Handler<'rename_session'> = async (_ctx, conn, msg) => {
  const abs = resolve(msg.workspacePath)
  try {
    await renameWorkspaceSession(abs, msg.sessionId, msg.title)
    await conn.sendSessions(abs)
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'session.renameFailed', params: { detail: errMsg(err) } },
    })
  }
}

export const setMode: Handler<'set_mode'> = async (_ctx, conn, msg) => {
  const rt = conn.viewing ? getRuntime(conn.viewing) : undefined
  // Requirement comm sessions are pinned to `default` (the gateway must always
  // fire); ignore mode changes for them.
  if (rt && rt.kind === 'requirement') {
    conn.send({ type: 'mode_changed', mode: 'default' })
    return
  }
  if (rt) {
    rt.mode = msg.mode
    // Persist for real sessions; pending sessions persist on bind.
    if (!rt.sessionId.startsWith(PENDING_SESSION_PREFIX)) {
      setSessionMode(rt.sessionId, msg.mode)
    }
    if (rt.run?.handle) {
      try {
        await rt.run.handle.setPermissionMode(msg.mode)
      } catch {
        /* query may have finished between check and call — ignore */
      }
    }
  }
  conn.send({ type: 'mode_changed', mode: msg.mode })
}

/**
 * Re-target a session's agent within its frozen vendor (ADR-0015 / AS-R22): rewrite
 * the `sessionAgents` fact so the session's next turn `resume`s with the new agent
 * (no immediate relaunch — the existing `launchRun`/`resolveSessionLaunch` path picks
 * it up on the next `user_prompt`). `setSessionAgent` enforces vendor immutability:
 * a cross-vendor change returns `{ ok: false }` and leaves the fact untouched. The
 * reply echoes the (unchanged) vendor for the client's local update; audit then runs
 * against the last valid agent (the rewritten fact). No-op without a viewed session.
 */
export const setSessionAgentHandler: Handler<'set_session_agent'> = (_ctx, conn, msg) => {
  const { ok } = setSessionAgent(msg.sessionId, msg.agentId)
  conn.send({
    type: 'session_agent_changed',
    sessionId: msg.sessionId,
    agentId: msg.agentId,
    vendor: resolveSessionVendor(msg.sessionId),
    ok,
  })
}

export const stopRunHandler: Handler<'stop_run'> = (_ctx, conn) => {
  if (conn.viewing) stopRun(conn.viewing)
}

export const userPrompt: Handler<'user_prompt'> = async (ctx, conn, msg) => {
  const rt = conn.viewing ? getRuntime(conn.viewing) : undefined
  if (!rt) {
    conn.send({ type: 'error', error: { code: 'session.notSelected' } })
    return
  }
  // Team session: the lead process is alive across turns, so feed the prompt
  // into the *same* run (no resume launch). The user may send even while the
  // lead is mid-turn — the SDK queues it.
  if (rt.team && rt.run?.handle) {
    emit(rt.sessionId, { type: 'user_text', text: msg.text })
    setStatus(rt.sessionId, 'running')
    rt.run.handle.pushInput(msg.text)
    return
  }
  if (rt.run) {
    conn.send({ type: 'error', error: { code: 'session.turnRunning' } })
    return
  }
  const isRequirement = rt.kind === 'requirement'
  await ctx.launchRun(rt, msg.text, {
    onEvent: (e) => {
      if (e.kind === 'bound') {
        const { prevId, realId } = e
        if (isRequirement) {
          // Comm session: re-key its store mapping; never touch the persisted
          // active/normal-mode state (it's a hidden session).
          rebindChatSession(prevId, realId)
          if (conn.viewing === prevId) conn.viewing = realId
        } else {
          setSessionMode(realId, rt.mode)
          if (conn.viewing === prevId) {
            conn.viewing = realId
            setActiveSessionId(realId)
          }
        }
        conn.send({ type: 'session_started', clientId: prevId, sessionId: realId })
      } else if (e.kind === 'settled' && !isRequirement) {
        // Requirement comm sessions are hidden from the normal list, so there's
        // nothing to refresh for them.
        void conn.sendSessions(e.workspacePath)
      }
    },
  })
}
