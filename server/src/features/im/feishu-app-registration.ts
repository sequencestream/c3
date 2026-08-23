/**
 * One-click Feishu app registration — connection lifecycle.
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
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn, Handler } from '../../transport/index.js'
import { requireAdmin } from '../auth/authz.js'
import {
  runFeishuAppRegistration,
  type FeishuRegistrationOutcome,
  type FeishuRegistrationProgress,
} from './providers/feishu/register.js'

interface ActiveTask {
  requestId: string
  controller: AbortController
}

const tasks = new Map<Conn, ActiveTask>()

function progressMessage(requestId: string, p: FeishuRegistrationProgress): ServerToClient {
  switch (p.status) {
    case 'starting':
      return { type: 'feishu_app_registration_progress', requestId, status: 'starting' }
    case 'waiting_scan':
      return {
        type: 'feishu_app_registration_progress',
        requestId,
        status: 'waiting_scan',
        verificationUrl: p.verificationUrl,
        expiresAt: p.expiresAt,
      }
    case 'slow_down':
      return { type: 'feishu_app_registration_progress', requestId, status: 'slow_down' }
    case 'configuring':
      return { type: 'feishu_app_registration_progress', requestId, status: 'configuring' }
  }
}

function resultMessage(requestId: string, o: FeishuRegistrationOutcome): ServerToClient {
  switch (o.kind) {
    case 'ready':
      return {
        type: 'feishu_app_registration_result',
        requestId,
        outcome: 'ready',
        appId: o.appId,
        appSecret: o.appSecret,
      }
    case 'manual_setup_required':
      return {
        type: 'feishu_app_registration_result',
        requestId,
        outcome: 'manual_setup_required',
        appId: o.appId,
        appSecret: o.appSecret,
        reason: o.reason,
      }
    case 'failed':
      return o.detail
        ? {
            type: 'feishu_app_registration_result',
            requestId,
            outcome: 'failed',
            reason: o.reason,
            detail: o.detail,
          }
        : {
            type: 'feishu_app_registration_result',
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
 * Start a registration task for `conn`. Returns false (and the caller emits a
 * `server_error` result) when the connection already owns an active task.
 */
export function startFeishuAppRegistration(conn: Conn, requestId: string): boolean {
  if (tasks.has(conn)) return false
  const controller = new AbortController()
  tasks.set(conn, { requestId, controller })
  void runFeishuAppRegistration({
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
export function cancelFeishuAppRegistration(conn: Conn, requestId: string): void {
  const task = tasks.get(conn)
  if (!task || task.requestId !== requestId) return
  task.controller.abort()
}

/**
 * Socket-close cleanup: abort the connection's task and drop it immediately —
 * nobody is listening, so no frames are sent after this point.
 */
export function abortFeishuAppRegistrationForConn(conn: Conn): void {
  const task = tasks.get(conn)
  if (!task) return
  task.controller.abort()
  tasks.delete(conn)
}

export const startFeishuAppRegistrationHandler: Handler<'start_feishu_app_registration'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  if (!startFeishuAppRegistration(conn, msg.requestId)) {
    conn.send({
      type: 'feishu_app_registration_result',
      requestId: msg.requestId,
      outcome: 'failed',
      reason: 'server_error',
      detail: 'an app registration is already active on this connection',
    })
  }
}

export const cancelFeishuAppRegistrationHandler: Handler<'cancel_feishu_app_registration'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  cancelFeishuAppRegistration(conn, msg.requestId)
}
