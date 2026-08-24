/**
 * One-click app registration — connection lifecycle (platform-neutral).
 *
 * The wire handlers are thin: admin gate, then start/cancel on a per-connection
 * task map. The map is the single owner of task lifetime — created on start,
 * aborted on cancel or socket close, removed when the run settles. It enforces
 * the "one active registration per connection" rule: a duplicate start is
 * refused with `server_error` instead of creating a parallel app.
 *
 * Progress and results are sent ONLY to the initiating connection (its `conn`
 * is the map key), and only while the frame's `requestId` is still the active
 * task — a late or mismatched frame is dropped, never broadcast.
 *
 * App Secret discipline: the `ready` / `manual_setup_required` result carrying
 * credentials appears exactly once, to the initiating connection, in memory.
 * It is never logged, broadcast or persisted before the robot is created.
 */
import type { ImPlatform, ServerToClient } from '@ccc/shared/protocol'
import type { Conn, Handler } from '../../transport/index.js'
import { requireAdmin } from '../auth/authz.js'
import { resolveAppRegistration } from './registry.js'
import type { AppRegistrationOutcome, AppRegistrationProgress } from './types.js'

interface ActiveTask {
  requestId: string
  controller: AbortController
}

const tasks = new Map<Conn, ActiveTask>()

function progressMessage(requestId: string, p: AppRegistrationProgress): ServerToClient {
  switch (p.status) {
    case 'starting':
      return { type: 'app_registration_progress', requestId, status: 'starting' }
    case 'waiting_scan':
      return {
        type: 'app_registration_progress',
        requestId,
        status: 'waiting_scan',
        verificationUrl: p.verificationUrl,
        expiresAt: p.expiresAt,
      }
    case 'slow_down':
      return { type: 'app_registration_progress', requestId, status: 'slow_down' }
    case 'configuring':
      return { type: 'app_registration_progress', requestId, status: 'configuring' }
  }
}

function resultMessage(requestId: string, o: AppRegistrationOutcome): ServerToClient {
  switch (o.kind) {
    case 'ready':
      return {
        type: 'app_registration_result',
        requestId,
        outcome: 'ready',
        appId: o.appId,
        appSecret: o.appSecret,
      }
    case 'manual_setup_required':
      return {
        type: 'app_registration_result',
        requestId,
        outcome: 'manual_setup_required',
        appId: o.appId,
        appSecret: o.appSecret,
        reason: o.reason,
      }
    case 'failed':
      return o.detail
        ? {
            type: 'app_registration_result',
            requestId,
            outcome: 'failed',
            reason: o.reason,
            detail: o.detail,
          }
        : {
            type: 'app_registration_result',
            requestId,
            outcome: 'failed',
            reason: o.reason,
          }
  }
}

/** Send a frame only while it belongs to the connection's ACTIVE task. */
function emitFor(conn: Conn, requestId: string, msg: ServerToClient): void {
  const task = tasks.get(conn)
  if (!task || task.requestId !== requestId) return
  conn.send(msg)
}

/**
 * Start a registration task for `conn` on `platform`. Returns false (and the
 * caller emits a `server_error` result) when the connection already owns an
 * active task. When the platform has no registration implementation, an
 * explicit unsupported result is sent immediately — no task is created.
 */
export function startAppRegistration(conn: Conn, platform: ImPlatform, requestId: string): boolean {
  if (tasks.has(conn)) return false
  const runner = resolveAppRegistration(platform)
  if (!runner) {
    conn.send({
      type: 'app_registration_result',
      requestId,
      outcome: 'failed',
      reason: 'server_error',
      detail: 'app registration is not supported for this platform',
    })
    return true
  }
  const controller = new AbortController()
  tasks.set(conn, { requestId, controller })
  void runner({
    signal: controller.signal,
    abort: () => controller.abort(),
    onProgress: (p) => emitFor(conn, requestId, progressMessage(requestId, p)),
    onResult: (o) => emitFor(conn, requestId, resultMessage(requestId, o)),
  }).finally(() => {
    const task = tasks.get(conn)
    if (task?.requestId === requestId) tasks.delete(conn)
  })
  return true
}

/**
 * Cancel the connection's active task, if its requestId matches. Idempotent:
 * an unknown or already-settled requestId is a no-op. The task entry stays
 * until the run settles so its `cancelled` result is still delivered.
 */
export function cancelAppRegistration(conn: Conn, requestId: string): void {
  const task = tasks.get(conn)
  if (!task || task.requestId !== requestId) return
  task.controller.abort()
}

/**
 * Socket-close cleanup: abort the connection's task and drop it immediately —
 * nobody is listening, so no frames are sent after this point.
 */
export function abortAppRegistrationForConn(conn: Conn): void {
  const task = tasks.get(conn)
  if (!task) return
  task.controller.abort()
  tasks.delete(conn)
}

export const startAppRegistrationHandler: Handler<'start_app_registration'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  if (!startAppRegistration(conn, msg.platform, msg.requestId)) {
    conn.send({
      type: 'app_registration_result',
      requestId: msg.requestId,
      outcome: 'failed',
      reason: 'server_error',
      detail: 'an app registration is already active on this connection',
    })
  }
}

export const cancelAppRegistrationHandler: Handler<'cancel_app_registration'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  cancelAppRegistration(conn, msg.requestId)
}
