/**
 * Write approval queue — the business-logic layer between the execution
 * dispatcher (which blocks on write-tool calls) and the WebSocket handler
 * (which broadcasts pending approvals and receives user decisions).
 *
 * Architecture:
 *
 *   dispatcher.ts  ──→  pendWriteApproval()  ──→  DB (store)
 *                                  │
 *                            Promise<Decision>
 *                                  │
 *                          (blocks canUseTool)
 *                                  │
 *                          resolved externally via
 *                         resolveApproval() ← WS handler
 *
 * The in-memory map `pending` holds a resolver per approval id so the WS
 * handler can unblock the dispatcher when the user approves or rejects.
 */

import {
  createWriteApproval as storeCreateApproval,
  getWriteApproval as storeGetApproval,
  listExpiredPendingApprovals,
  resolveWriteApproval as storeResolveApproval,
} from './store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalDecision = 'approved' | 'rejected' | 'expired'

export interface ApprovalResolvedEvent {
  approvalId: string
  scheduleId: string
  workspacePath: string
  status: ApprovalDecision
}

export type BroadcastFn = (event: {
  type: 'pending' | 'resolved'
  approval: unknown // PendingWriteApproval | ApprovalResolvedEvent
}) => void

// ---------------------------------------------------------------------------
// In-memory pending resolvers
// ---------------------------------------------------------------------------

/**
 * Map<approvalId, { resolve, reject }>.
 * `resolve(true)` → approved; `resolve(false)` → denied/expired.
 */
const pending = new Map<string, (decision: boolean) => void>()

let broadcast: BroadcastFn | null = null
let expiryTimer: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Set the broadcast callback (called once by server.ts on init). */
export function setBroadcast(fn: BroadcastFn): void {
  broadcast = fn
}

/**
 * Create a pending write approval and return a Promise that resolves to:
 * - `true`  → the user approved (execute the tool)
 * - `false` → the user rejected or the approval expired (deny the tool)
 *
 * The promise is stored in the in-memory map. `resolveApproval()` looks it
 * up by approval id and resolves it. On timeout, the expiry scanner resolves
 * it to `false`.
 */
export function pendWriteApproval(input: {
  scheduleId: string
  workspacePath: string
  toolName: string
  toolInput: unknown
  diffPreview: string
  /**
   * Time-to-live in ms from creation. Default 5 minutes.
   * The caller (dispatcher) is responsible for providing a reasonable TTL.
   */
  ttlMs?: number
}): Promise<boolean> {
  const ttlMs = input.ttlMs ?? 5 * 60 * 1000
  const expiresAt = Date.now() + ttlMs

  const approval = storeCreateApproval({
    scheduleId: input.scheduleId,
    workspacePath: input.workspacePath,
    toolName: input.toolName,
    toolInput: input.toolInput,
    diffPreview: input.diffPreview,
    expiresAt,
  })

  // Notify listeners (WS broadcast)
  broadcast?.({ type: 'pending', approval })

  return new Promise<boolean>((resolve) => {
    pending.set(approval.id, resolve)
  })
}

/**
 * Resolve a pending approval. Called by the WS handler when the user
 * approves or rejects. Returns true if the approval was found and resolved,
 * false if unknown or already resolved.
 */
export function resolveApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  resolvedBy?: string,
): boolean {
  const resolver = pending.get(approvalId)
  if (!resolver) {
    // Already resolved or unknown — try DB (might be a late WS message after expiry).
    const existing = storeGetApproval(approvalId)
    if (!existing || existing.status !== 'pending') return false
    // Same-day resolution: race with the expiry scanner. The store will reject
    // the resolve if the status has changed under us.
    const updated = storeResolveApproval(
      approvalId,
      decision === 'approve' ? 'approved' : 'rejected',
      resolvedBy,
    )
    if (!updated) return false
    // The promise is already gone (expired or resolved by another conn) — just
    // ensure the DB is updated. The caller doesn't wait.
    return true
  }

  pending.delete(approvalId)

  // Read scheduleId from the persisted approval for the broadcast.
  const persisted = storeGetApproval(approvalId)
  const storeStatus: 'approved' | 'rejected' = decision === 'approve' ? 'approved' : 'rejected'
  storeResolveApproval(approvalId, storeStatus, resolvedBy)

  const isApproved = decision === 'approve'
  resolver(isApproved)

  broadcast?.({
    type: 'resolved',
    approval: {
      approvalId,
      status: storeStatus,
      scheduleId: persisted?.scheduleId ?? '',
    },
  })

  return true
}

/**
 * Cancel (reject) all pending approvals for a given schedule.
 * Used when a schedule execution is aborted or the schedule is deleted mid-flight.
 */
export function cancelAllForSchedule(scheduleId: string): void {
  // Find all pending entries for this schedule
  for (const [approvalId, resolver] of pending) {
    // We need the scheduleId — we stored it in a side map or can derive from DB
    // Since we don't have a direct lookup, we iterate and check DB for each
    const approval = storeGetApproval(approvalId)
    if (approval && approval.scheduleId === scheduleId) {
      pending.delete(approvalId)
      storeResolveApproval(approvalId, 'expired', 'system')
      resolver(false)
      broadcast?.({
        type: 'resolved',
        approval: {
          approvalId,
          status: 'expired',
          scheduleId,
        },
      })
    }
  }
}

/**
 * Cancel all pending approvals for a workspace.
 * Used when a workspace is removed.
 */
export function cancelAllForWorkspace(workspacePath: string): void {
  for (const [approvalId, resolver] of pending) {
    const approval = storeGetApproval(approvalId)
    if (approval && approval.workspacePath === workspacePath) {
      pending.delete(approvalId)
      storeResolveApproval(approvalId, 'expired', 'system')
      resolver(false)
      broadcast?.({
        type: 'resolved',
        approval: {
          approvalId,
          status: 'expired',
          scheduleId: approval.scheduleId,
        },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Expiry scanner
// ---------------------------------------------------------------------------

const EXPIRY_INTERVAL_MS = 1_000 // check every second

/**
 * Start the background expiry scanner that auto-rejects overdue approvals.
 * Safe to call multiple times (no-op if already running).
 */
export function startExpiryScanner(): void {
  if (expiryTimer !== null) return
  expiryTimer = setInterval(() => {
    try {
      scanExpired()
    } catch (err) {
      console.error('[write-approval] expiry scan error:', err)
    }
  }, EXPIRY_INTERVAL_MS)
}

/** Stop the expiry scanner. */
export function stopExpiryScanner(): void {
  if (expiryTimer !== null) {
    clearInterval(expiryTimer)
    expiryTimer = null
  }
}

function scanExpired(): void {
  const expired = listExpiredPendingApprovals()
  for (const approval of expired) {
    const resolver = pending.get(approval.id)
    if (resolver) {
      pending.delete(approval.id)
      storeResolveApproval(approval.id, 'expired', 'system')
      resolver(false)
      broadcast?.({
        type: 'resolved',
        approval: {
          approvalId: approval.id,
          status: 'expired',
          scheduleId: approval.scheduleId,
        },
      })
    } else {
      // Already resolved in-memory but DB still says pending — race with
      // resolveApproval. Safe to update DB (resolveWriteApproval checks
      // status and returns false if already resolved).
      storeResolveApproval(approval.id, 'expired', 'system')
    }
  }
}

/** Number of in-flight pending approvals (for diagnostics). */
export function pendingCount(): number {
  return pending.size
}
