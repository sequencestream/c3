/**
 * Per-connection lifecycle for the native directory chooser.
 *
 * One picker per connection, newest wins. The connection owns a single slot
 * guarded by a request id AND a monotonic generation, so a child that finishes
 * after its run was cancelled or superseded is dropped: it must not answer a
 * different form, and it must not clear a newer run's slot.
 *
 * Aborting a run kills the live child and frees the slot immediately, without
 * waiting for the operating system to finish tearing the process down — the next
 * request never queues behind a dialog someone left open.
 */
import type { WorkspaceDirectorySelectionResult } from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import { isAdminConn, requireAdmin } from '../auth/authz.js'
import type { Conn, Handler } from '../../transport/handler-registry.js'
import { startDirectoryChooser, type DirectoryChoice } from './native-chooser.js'

/** The one picker a connection may have in flight. */
interface ActivePicker {
  requestId: string
  /** Distinguishes two runs that reuse a request id; only the newest owns the slot. */
  generation: number
  abort: () => void
}

const activePickers = new WeakMap<Conn, ActivePicker>()
let generationSeq = 0

/** Kill and forget a connection's picker, if it has one. */
function clearActivePicker(conn: Conn): void {
  const active = activePickers.get(conn)
  if (!active) return
  activePickers.delete(conn)
  active.abort()
}

/**
 * Free a connection's picker slot on socket teardown. Called from the WS close
 * hook so a dialog left open on the host cannot pin a dead connection's child.
 */
export function releaseWorkspaceDirectoryPicker(conn: Conn): void {
  clearActivePicker(conn)
}

const PICKER_FAILED: UiError = { code: 'workspace.directoryPickerFailed' }

/** Map an internal choice onto the wire, logging the failure detail server-side. */
function toWireResult(choice: DirectoryChoice): WorkspaceDirectorySelectionResult {
  if (choice.kind === 'selected') return { kind: 'selected', path: choice.path }
  if (choice.kind === 'cancelled') return { kind: 'cancelled' }
  console.warn('[c3:workspaces] native directory chooser failed:', choice.detail)
  return { kind: 'failed', error: PICKER_FAILED }
}

/**
 * Open a chooser and answer the correlated request. Gated exactly like
 * `add_workspace` — this is the front door to a trust root.
 *
 * Returns as soon as the child is launched. The reply is emitted from the
 * child's completion callback, and only while this run still owns the slot.
 */
export const selectWorkspaceDirectoryHandler: Handler<'select_workspace_directory'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!conn.authed) {
    conn.send({ type: 'unauthenticated', reason: 'missing' })
    return
  }
  if (!requireAdmin(conn)) return

  // Newest wins: a still-open dialog from an earlier request is torn down rather
  // than turned into a failure for this one.
  clearActivePicker(conn)
  const generation = ++generationSeq
  const run = startDirectoryChooser()
  activePickers.set(conn, { requestId: msg.requestId, generation, abort: run.abort })

  void run.result.then((choice) => {
    const active = activePickers.get(conn)
    // Cancelled or superseded: this child no longer speaks for the connection.
    if (!active || active.generation !== generation) return
    activePickers.delete(conn)
    conn.send({
      type: 'workspace_directory_selection',
      requestId: msg.requestId,
      result: toWireResult(choice),
    })
  })
}

/**
 * Drop a picker the client stopped waiting for. Silent by contract: the
 * correlated reply is suppressed, so there is nothing to send back.
 *
 * Authorization is structural — only an authorized `select_workspace_directory`
 * can create a slot on this connection — but the gate is stated explicitly so a
 * connection that lost its authority cannot reach into the registry either.
 */
export const cancelWorkspaceDirectorySelectionHandler: Handler<
  'cancel_workspace_directory_selection'
> = (_ctx, conn, msg) => {
  if (!conn.authed || !isAdminConn(conn)) return
  const active = activePickers.get(conn)
  // A stale cancel (its run was already superseded) must not abort the new run.
  if (!active || active.requestId !== msg.requestId) return
  clearActivePicker(conn)
}
