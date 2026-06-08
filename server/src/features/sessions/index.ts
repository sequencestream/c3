/**
 * `sessions` feature handlers — slice 1/3 (ADR-0009).
 *
 * The core session lifecycle: list/create/select/delete/rename, mode, stop, and
 * the user prompt launch. `(ctx, conn, msg)` signature; per-connection `viewing`
 * + delivery live on `conn`, shared services on `ctx`.
 */
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PermissionMode } from '@ccc/shared/protocol'
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
import {
  resolveAgent,
  resolveSessionAgentSwitch,
  resolveSessionVendor,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
import { probeAll } from '../../kernel/agent/process/launcher.js'
import { MODE_CATALOGS, isKnownToken } from '../../kernel/agent/adapters/index.js'
import { deriveTasksFromHistory } from '../../kernel/agent/task-tracker.js'
import type { SessionAgentSwitch, VendorId } from '@ccc/shared/protocol'
import { loadHistory, removeSession, renameWorkspaceSession, sessionTitle } from '../../sessions.js'
import { listCommands } from '../../commands.js'
import { rebindChatSession } from '../intents/store.js'
import { ensureOpencodeRunning } from '../../opencode-status.js'
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
  const defaultMode = getDefaultMode(abs, resolvedAgent.vendor)
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
    // OpenCode is a long-lived local REST server every back-read / resume talks to
    // (2026-06-07-003). Lazily (re)start it within its grace window before opening an
    // opencode session. A down server degrades honestly — `ensureOpencodeRunning` never
    // throws, the first-class `opencode_status` signal flips to `temporarily-unavailable`
    // + self-heals, and the console shows the offline/retry warning — so selection is
    // NEVER fatal on a cold server. Gate by the session's resolved vendor, not identity
    // checks scattered downstream.
    const effectiveVendor = resolveSessionVendor(msg.sessionId)
    if (effectiveVendor === 'opencode') await ensureOpencodeRunning()
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
          getSessionMode(msg.sessionId, getDefaultMode(abs, effectiveVendor)),
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
      vendor: resolveSessionVendor(msg.sessionId),
      agentSwitch: agentSwitchFor(msg.sessionId),
    })
    // Task-list cold replay (2026-06-07-009): the baseline transcript predates
    // this process and carries no `task_list` events, so derive the model from
    // it and send the snapshot BEFORE the live buffer tail (which may hold newer
    // `task_list` events that must override this cold seed). Skipped when empty.
    const baselineTasks = deriveTasksFromHistory(rt.baseline)
    if (baselineTasks.tasks.length > 0) {
      conn.send({ type: 'task_list', tasks: baselineTasks.tasks })
    }
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
  // Intent comm sessions are pinned to `default` (the gateway must always
  // fire); ignore mode changes for them.
  if (rt && rt.kind === 'intent') {
    conn.send({ type: 'mode_changed', mode: 'default' })
    return
  }
  if (rt) {
    // Validate the mode token against the session's vendor catalog (2026-06-07-017).
    // An unknown token for this vendor is rejected; the client's per-vendor mode
    // picker should never send one (defensive guard).
    const vendor = resolveSessionVendor(rt.sessionId)
    const cat = MODE_CATALOGS[vendor]
    if (cat && !isKnownToken(cat, msg.mode)) {
      conn.send({
        type: 'error',
        error: { code: 'session.invalidMode', params: { vendor, mode: msg.mode } },
      })
      return
    }

    rt.mode = msg.mode
    // Persist for real sessions; pending sessions persist on bind.
    if (!rt.sessionId.startsWith(PENDING_SESSION_PREFIX)) {
      setSessionMode(rt.sessionId, msg.mode)
    }
    // A live RunHandle exists only on the claude-hardwired path (the driver path
    // sets `handle: null`), so after the vendor-catalog check above the token is
    // confirmed to be a valid Claude `PermissionMode` here; other vendors have no
    // live set-mode and pick up the new token on their next resume (2026-06-07-012).
    if (rt.run?.handle) {
      try {
        await rt.run.handle.setPermissionMode(msg.mode as PermissionMode)
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
  const isIntent = rt.kind === 'intent'
  // Subscribe to kernel event bus for lifecycle events (ADR-0018).
  const disposers: (() => void)[] = []
  disposers.push(
    ctx.eventBus.subscribe('run:bound', (e) => {
      const { prevId, realId } = e
      if (isIntent) {
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
    }),
  )
  disposers.push(
    ctx.eventBus.subscribe('run:settled', (e) => {
      if (!isIntent) {
        // Intent comm sessions are hidden from the normal list, so there's
        // nothing to refresh for them.
        void conn.sendSessions(e.workspacePath)
      }
      // Clean up subscriptions (settled always fires in the finally block).
      disposers.forEach((d) => d())
    }),
  )
  try {
    await ctx.launchRun(rt, msg.text)
  } finally {
    // Safety-net cleanup if the run never reached settled.
    disposers.forEach((d) => d())
  }
}
