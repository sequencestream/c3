/**
 * Pre-launch skill-load approval — the trust / `.gitignore` gate state machine
 * (mount layer 2/3, ADR-0017). Two halves:
 *
 *  1. Transport (mirrors `features/schedules/queue.ts` but is its own in-memory
 *     map, NOT SQLite-backed): the backend emits a `skill_load_approval_request`
 *     and blocks on a Promise the WS handler resolves via
 *     `resolveSkillApproval(requestId, decision)`. The modal UI itself is 3/3.
 *
 *  2. Gate evaluation + ack persistence (pure reads/writes over `state.json`):
 *     when does a `trust` tier or a first-time `.gitignore` write actually need a
 *     human, and how is the ack recorded so the next session stays silent.
 *
 * The gate policy (spec §7):
 *  - `pinned`           — never a modal; integrity is the post-clone `cat-file`
 *                         check (1/3), a ref change is an *error*, not an ack.
 *  - `review-on-update` — ask on first load and whenever the resolved ref changed
 *                         since the recorded `reviewedRef`; silent on an unchanged ref.
 *  - `unreviewed`       — ask on every mount; a cancel aborts the launch.
 *  - `.gitignore`       — ask once per project before the first mount; acked, then silent.
 */
import { randomUUID } from 'node:crypto'
import type {
  ServerToClient,
  SkillApprovalKind,
  SkillRepoConfig,
  VendorId,
} from '@ccc/shared/protocol'
import { getSkillAck, setSkillAck, skillLinkKey } from '../../state.js'

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

/** Wire the broadcast sink (called once by the server on init). */
export function setSkillApprovalSend(fn: (msg: ServerToClient) => void): void {
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
  send?.({
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
// Gate evaluation + ack persistence
// ---------------------------------------------------------------------------

/** Why a trust gate fired (or that it didn't), for the orchestrator + the request detail. */
export type TrustGateVerdict =
  | { needsApproval: false }
  | { needsApproval: true; reason: 'first-load' | 'ref-change' }

/**
 * Decide whether mounting `config` for `vendor` at `resolvedRef` needs a human
 * trust ack. `pinned` never does (its integrity is the cat-file check, a ref
 * change is handled as an error by the orchestrator). `unreviewed` always does.
 * `review-on-update` does on first load or when the ref changed since the ack.
 */
export function evaluateTrustGate(
  projectDir: string,
  config: SkillRepoConfig,
  vendor: VendorId,
  resolvedRef: string,
): TrustGateVerdict {
  if (config.trust === 'pinned') return { needsApproval: false }
  if (config.trust === 'unreviewed') return { needsApproval: true, reason: 'first-load' }
  // review-on-update
  const ack = getSkillAck(skillLinkKey(projectDir, vendor, config.id))
  if (!ack || ack.reviewedRef === undefined) return { needsApproval: true, reason: 'first-load' }
  if (ack.reviewedRef !== resolvedRef) return { needsApproval: true, reason: 'ref-change' }
  return { needsApproval: false }
}

/**
 * Persist a trust ack after a human approve. Only `review-on-update` records a
 * `reviewedRef` (so the same ref stays silent); `unreviewed` records nothing (it
 * always re-asks); `pinned` has no ack.
 */
export function recordTrustAck(
  projectDir: string,
  config: SkillRepoConfig,
  vendor: VendorId,
  resolvedRef: string,
): void {
  if (config.trust === 'review-on-update') {
    setSkillAck(skillLinkKey(projectDir, vendor, config.id), { reviewedRef: resolvedRef })
  }
}

/** Whether this project still needs the one-time `.gitignore`-append ack. */
export function needsGitignoreAck(projectDir: string): boolean {
  return getSkillAck(projectDir)?.gitignore !== true
}

/** Record the one-time `.gitignore` ack for a project. */
export function recordGitignoreAck(projectDir: string): void {
  setSkillAck(projectDir, { gitignore: true })
}
