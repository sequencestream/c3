/**
 * OpenCode server reachability — runtime singleton (2026-06-07-003).
 *
 * The supervised OpenCode REST server's up/down state is a first-class product
 * signal (see {@link import('@ccc/shared/protocol').OpencodeServerStatus}), read by
 * several seams that must NOT each hold a supervisor reference:
 *  - the `settings` handler overlays it onto `sessionCapabilities.opencode`;
 *  - the `select_session` handler lazily ensures the server before opening an
 *    opencode session, degrading honestly instead of treating a down server as fatal;
 *  - the broadcast wiring ships the `opencode_status` frame.
 *
 * Rather than thread the supervisor through the kernel boundary, the composition
 * root registers the latest status + a lazy-start thunk here (the same runtime-
 * singleton-with-setter shape as `runs.setOnStatusChange` / `setAutomationHooks`).
 * The supervisor stays the source of truth; this module is the read seam for the
 * feature/wiring layers. Default `'none'` = opencode not registered at all.
 */
import type { OpencodeServerStatus } from '@ccc/shared/protocol'

let current: OpencodeServerStatus = { reachability: 'none', retrying: false }
let ensureFn: (() => Promise<void>) | null = null

/** The composition root pushes the supervisor's latest reachability snapshot here. */
export function setOpencodeStatus(status: OpencodeServerStatus): void {
  current = status
}

/** The latest reachability snapshot (the wire signal + settings overlay read this). */
export function getOpencodeStatus(): OpencodeServerStatus {
  return current
}

/** Register the supervisor's lazy-start thunk (composition root). */
export function setOpencodeEnsure(fn: (() => Promise<void>) | null): void {
  ensureFn = fn
}

/**
 * Lazily (re)start the OpenCode server within its grace window. No-op (resolves)
 * when opencode is not registered. Never throws — the supervisor degrades honestly
 * and self-heals; callers branch on {@link getOpencodeStatus} afterwards.
 */
export async function ensureOpencodeRunning(): Promise<void> {
  if (!ensureFn) return
  try {
    await ensureFn()
  } catch {
    /* ensureRunning is contractually non-throwing; swallow defensively */
  }
}
