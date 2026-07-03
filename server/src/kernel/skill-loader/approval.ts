/**
 * Pre-launch skill-load approval — the `.gitignore` gate (mount layer 2/3,
 * ADR-0017). External skills mount silently (the configured `ref`'s head is
 * resolved and linked with no trust check), so the only remaining gate is the
 * one-time `.gitignore` append. Two halves:
 *
 *  1. Transport (mirrors `features/automations/queue.ts` but is its own in-memory
 *     map, NOT SQLite-backed): the backend emits a `skill_load_approval_request`
 *     and blocks on a Promise the WS handler resolves via
 *     `resolveSkillApproval(requestId, decision)`. The modal UI itself is 3/3.
 *
 *  2. Ack persistence (pure reads/writes over `state.json`): the first-time
 *     `.gitignore` write is acked once per project, then stays silent.
 */
import { randomUUID } from 'node:crypto'
import type { ServerToClient, SkillApprovalKind, VendorId } from '@ccc/shared/protocol'
import { getSkillAck, setSkillAck } from '../../state.js'

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** What the backend asks the human to resolve. Carried on the wire as a request. */
export interface SkillApprovalAsk {
  kind: SkillApprovalKind
  id: string
  vendor: VendorId
  repo: string
  ref: string
  detail: string
}

/** Resolves a pending ask: `true` = approve, `false` = cancel/abort. */
type Resolver = (approved: boolean) => void

const pending = new Map<string, Resolver>()
let send: ((msg: ServerToClient) => void) | null = null

/** Wire the broadcast sink (called once by the server on init); `null` unwires it. */
export function setSkillApprovalSend(fn: ((msg: ServerToClient) => void) | null): void {
  send = fn
}

/**
 * Emit a skill-load approval request and return a Promise that resolves to the
 * human's decision (`true` approve / `false` cancel). An aborted `signal` resolves
 * it to `false` and drops the pending entry (teardown ⇒ treat as cancel).
 */
export function requestSkillApproval(
  ask: SkillApprovalAsk,
  signal?: AbortSignal,
): Promise<boolean> {
  const requestId = randomUUID()
  if (signal?.aborted) return Promise.resolve(false)
  // No egress wired ⇒ no client can ever answer. Resolve as cancel instead of
  // returning a promise that never settles: a never-settling ask would hang the
  // pre-launch `skillMount` await in `launchRun`, blocking the run from ever
  // starting. Degrade to "skip this mount" (the module's silent-failure contract).
  if (!send) return Promise.resolve(false)
  send({
    type: 'skill_load_approval_request',
    requestId,
    kind: ask.kind,
    id: ask.id,
    vendor: ask.vendor,
    repo: ask.repo,
    ref: ask.ref,
    detail: ask.detail,
  })
  return new Promise<boolean>((resolve) => {
    pending.set(requestId, resolve)
    if (signal) {
      const onAbort = () => {
        if (pending.delete(requestId)) resolve(false)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Resolve a pending skill-load approval (called by the WS handler on a
 * `skill_load_approval_resolve`). Returns true if a pending ask was found.
 */
export function resolveSkillApproval(requestId: string, decision: 'approve' | 'cancel'): boolean {
  const resolver = pending.get(requestId)
  if (!resolver) return false
  pending.delete(requestId)
  resolver(decision === 'approve')
  return true
}

/** Cancel every in-flight ask (server shutdown / hard reset) — resolves them to `false`. */
export function cancelAllSkillApprovals(): void {
  for (const [, resolver] of pending) resolver(false)
  pending.clear()
}

/** Diagnostics: number of in-flight asks. */
export function pendingSkillApprovalCount(): number {
  return pending.size
}

/**
 * WS handler for `skill_load_approval_resolve` — dispatches the user's decision
 * to the matching in-flight ask. Exported for the feature handler registry.
 */
export const resolveSkillApprovalHandler: (
  requestId: string,
  decision: 'approve' | 'cancel',
) => boolean = resolveSkillApproval

// ---------------------------------------------------------------------------
// Ack persistence
// ---------------------------------------------------------------------------

/** Whether this project still needs the one-time `.gitignore`-append ack. */
export function needsGitignoreAck(projectDir: string): boolean {
  return getSkillAck(projectDir)?.gitignore !== true
}

/** Record the one-time `.gitignore` ack for a project. */
export function recordGitignoreAck(projectDir: string): void {
  setSkillAck(projectDir, { gitignore: true })
}
