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
import { getDefaultMode } from '../../kernel/config/index.js'
import { loadHistory, removeSession, renameWorkspaceSession, sessionTitle } from '../../sessions.js'
import { listCommands } from '../../commands.js'
import { rebindChatSession } from '../requirements/store.js'
import { errMsg } from '../errmsg.js'
import type { Handler } from '../../transport/handler-registry.js'

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
  })
  conn.sendWorkspaces()
}

export const selectSession: Handler<'select_session'> = async (_ctx, conn, msg) => {
  const abs = resolve(msg.workspacePath)
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  try {
    const existing = getRuntime(msg.sessionId)
    const title = await sessionTitle(abs, msg.sessionId)
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
          await loadHistory(abs, msg.sessionId),
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
    onSessionId: (prev, sid) => {
      if (isRequirement) {
        // Comm session: re-key its store mapping; never touch the persisted
        // active/normal-mode state (it's a hidden session).
        rebindChatSession(prev, sid)
        if (conn.viewing === prev) conn.viewing = sid
      } else {
        setSessionMode(sid, rt.mode)
        if (conn.viewing === prev) {
          conn.viewing = sid
          setActiveSessionId(sid)
        }
      }
      conn.send({ type: 'session_started', clientId: prev, sessionId: sid })
    },
    // Requirement comm sessions are hidden from the normal list, so there's
    // nothing to refresh for them.
    onSettled: isRequirement
      ? undefined
      : async (wp) => {
          await conn.sendSessions(wp)
        },
  })
}
