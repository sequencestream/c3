/**
 * Vendor-blocked next step — the derived `Intent.actionDescriptor` projection.
 *
 * A vendor that rejects our credentials, or has no usable quota left, is the one
 * failure a retry can never clear: every intent behind it piles up silently. This
 * module turns that already-collected failure fact into the minimal "what can the
 * human do about it" projection the list and the detail both render.
 *
 * It is a **read-only bypass over the existing run layer**: the only input is the
 * `agent:error` event the degradation chain already publishes, and nothing here
 * touches the chain, the queue's gate/reason/retry/park decisions, or any stored
 * column. The fact table is in-memory and per-intent; the descriptor is re-derived
 * at every send boundary and never persisted.
 *
 * Two of the six failure shapes the run layer sees produce a descriptor:
 *   - `vendor_auth_invalid`    — credentials rejected.
 *   - `vendor_quota_exhausted` — quota gone AND no automatic recovery scheduled.
 * A connection error, a 5xx, a plain rate limit, and a session limit that carries
 * a reset time (which `agent-quota-recovery` already re-enables on a timer) all
 * resolve themselves, so they deliberately produce nothing.
 */
import type { ActionDescriptor, ActionLabelCode, Intent, VendorId } from '@ccc/shared/protocol'
import { getTimezone } from '../../kernel/config/index.js'
import { parseQuotaResetAt, resolveAgent } from '../../kernel/agent-config/index.js'
import { peekPendingDevLink } from './dev-link.js'
import { peekPendingIntentLink } from './intent-link.js'
import { peekPendingSpecLink } from './spec-link.js'
import { peekPendingSpecReviewLink } from './spec-review-link.js'
import { listIntents } from './store.js'

/**
 * Credentials rejected by the vendor. Narrower than the degradation classifier's
 * `auth` branch on purpose: that one only has to decide "try another agent", this
 * one puts a red banner in front of the user, so a stray "author" in a tool error
 * must not trip it.
 */
const VENDOR_AUTH_RE =
  /\b401\b|unauthori[sz]ed|authentication|invalid\s*api.?key|invalid\s*token|invalid\s*credentials?|\bauth\s*(?:failed|error)\b|not\s*logged\s*in/i

/**
 * The vendor says there is nothing left to spend. Only the exhaustion wording —
 * a bare 429 / "rate limit" / "session limit" is throttling, not exhaustion, and
 * clears on its own.
 */
const VENDOR_QUOTA_RE =
  /\bquota\b|resource[\s_-]*exhausted|insufficient[\s_-]*quota|\bexhausted\b|out\s*of\s*credits?|credit\s*balance\s*is\s*too\s*low/i

/** One recorded vendor-blocking failure, as the projection needs to render it. */
export interface VendorBlockFact {
  reason: ActionLabelCode
  /** The vendor of the agent that failed — the settings context to jump into. */
  vendor: VendorId
  /** The agent row that failed, captured at record time so a later delete cannot erase it. */
  agentId: string
  /** The run whose failure produced this fact (pending id when it failed before binding). */
  sessionId: string
  at: number
}

/**
 * intentId → the latest vendor-blocking failure for that intent. In-memory only:
 * it does not survive a restart, and nothing depends on it doing so — the next
 * run re-produces the fact, and a clean run clears it.
 */
const facts = new Map<string, VendorBlockFact>()

/**
 * Classify a raw agent error into the stable reason behind a next-step action, or
 * `null` when the failure is one the system resolves by itself.
 *
 * `timezone` / `now` are injected only so the "does this quota error already have
 * an automatic recovery scheduled" check is testable; they default to the live
 * server configuration.
 */
export function classifyVendorBlock(
  error: string,
  opts: { timezone?: string; now?: number } = {},
): ActionLabelCode | null {
  if (!error) return null
  if (VENDOR_AUTH_RE.test(error)) return 'vendor_auth_invalid'
  if (!VENDOR_QUOTA_RE.test(error)) return null
  // A limit that names its reset time is already handled: `agent-quota-recovery`
  // disables the agent and schedules its re-enable, so asking the user to open
  // settings would be wrong.
  const timezone = opts.timezone ?? getTimezone()
  if (parseQuotaResetAt(error, timezone, opts.now) !== null) return null
  return 'vendor_quota_exhausted'
}

/**
 * Which intent a run belongs to. Checks the pending→intent launch tables FIRST
 * (without consuming them — `run:bound` still owns that): an authentication
 * failure typically happens before the session ever binds, so at that moment the
 * intent's stored session ids do not name this run yet. Falls back to the stored
 * ids for a resumed or already-bound session.
 */
export function resolveIntentIdForSession(
  sessionId: string,
  workspacePath: string,
): string | undefined {
  const pending =
    peekPendingDevLink(sessionId) ??
    peekPendingSpecLink(sessionId) ??
    peekPendingSpecReviewLink(sessionId) ??
    peekPendingIntentLink(sessionId)
  if (pending) return pending
  const match = listIntents(workspacePath).find(
    (r) =>
      r.lastWorkSessionId === sessionId ||
      r.intentSessionId === sessionId ||
      r.specSessionId === sessionId ||
      r.specReviewSessionId === sessionId,
  )
  return match?.id
}

/**
 * Record a vendor-blocking failure against the intent that ran it. Returns the
 * intent id when a fact was stored (the caller re-broadcasts that project's
 * intents so the banner appears without a refresh), `null` when the error is
 * self-resolving or the run belongs to no intent.
 */
export function noteVendorBlock(input: {
  sessionId: string
  workspacePath: string
  agentId: string
  error: string
  now?: number
}): string | null {
  const reason = classifyVendorBlock(input.error, { now: input.now })
  if (!reason) return null
  const intentId = resolveIntentIdForSession(input.sessionId, input.workspacePath)
  if (!intentId) return null
  // Freeze the vendor at record time: the settings jump must still know which
  // configuration context to open even if the agent row is deleted afterwards.
  facts.set(intentId, {
    reason,
    vendor: resolveAgent(input.agentId).vendor,
    agentId: input.agentId,
    sessionId: input.sessionId,
    at: input.now ?? Date.now(),
  })
  return intentId
}

/**
 * Drop the fact for whichever intent this run belongs to. Called when a run
 * settles successfully: the vendor answered, so the recorded block no longer
 * describes reality. Returns the cleared intent id, or `null` when there was
 * nothing to clear.
 */
export function clearVendorBlockForSession(
  sessionId: string,
  workspacePath: string,
): string | null {
  const intentId = resolveIntentIdForSession(sessionId, workspacePath)
  if (!intentId || !facts.has(intentId)) return null
  facts.delete(intentId)
  return intentId
}

/** Drop an intent's fact outright (the intent is gone / was reset). Idempotent. */
export function clearVendorBlock(intentId: string): void {
  facts.delete(intentId)
}

/**
 * The send-time projection: an intent's recorded vendor block as the minimal
 * display + navigation pair, or `null` when nothing blocks it. Pure — it reads
 * the fact table and builds a fresh object, never mutating either side.
 */
export function deriveActionDescriptor(intent: Pick<Intent, 'id'>): ActionDescriptor | null {
  const fact = facts.get(intent.id)
  if (!fact) return null
  return {
    labelCode: fact.reason,
    target: { type: 'system-settings-agent', vendor: fact.vendor, agentId: fact.agentId },
  }
}

/** Reset the fact table (test teardown only). */
export function resetForTests(): void {
  facts.clear()
}
