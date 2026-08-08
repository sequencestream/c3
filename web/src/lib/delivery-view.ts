/**
 * Delivery-view display rules shared by the page components.
 *
 * Pure — no i18n, no WS, no state. The reachability/gaps themselves are
 * server-computed (`delivery_transition_plan`); the page only decides HOW to
 * render a plan the server already produced, so it can never relax the rules.
 */
import type {
  DeliveryGuardReason,
  DeliveryStatus,
  DeliveryTargetTransition,
  DeliveryTransitionPlan,
} from '@ccc/shared/protocol'
import { DELIVERY_STATUSES } from '@ccc/shared/protocol'
import type { LocaleKey } from '@/i18n'

/** The six statuses in forward path order (the segmented-control layout). */
export const DELIVERY_STATUS_ORDER: readonly DeliveryStatus[] = [...DELIVERY_STATUSES]

/** Status → locale leaf key (the Chinese side is pinned by i18n-terms.md). */
export const DELIVERY_STATUS_LABEL_KEYS: Record<DeliveryStatus, LocaleKey> = {
  planned: 'delivery.status.planned.label',
  integrating: 'delivery.status.integrating.label',
  verifying: 'delivery.status.verifying.label',
  verified: 'delivery.status.verified.label',
  delivered: 'delivery.status.delivered.label',
  cancelled: 'delivery.status.cancelled.label',
}

/**
 * Edge `from → to` → the advance BUTTON's locale key. A button says what pressing
 * it does; the status name says where the delivery is. Reusing
 * {@link DELIVERY_STATUS_LABEL_KEYS} here made 「验证中」 read as the current state
 * rather than an action, so the two keyspaces stay separate — the badge keeps the
 * status names, the buttons get their own verbs.
 *
 * Only the four human edges need an entry; every other edge is system-only and
 * never renders a button (see {@link deliveryTargetInvokable}).
 */
const DELIVERY_ADVANCE_LABEL_KEYS: Partial<Record<string, LocaleKey>> = {
  'planned→integrating': 'delivery.action.startIntegrating.label',
  'integrating→verifying': 'delivery.action.startVerifying.label',
  'verifying→verified': 'delivery.action.confirmVerification.label',
  'verifying→integrating': 'delivery.action.rework.label',
}

/**
 * The advance button's label key for one edge. Unmapped edges fall back to the
 * status name — defensive only: they belong to system-only edges that never reach
 * a button.
 */
export function deliveryAdvanceLabelKey(from: DeliveryStatus, to: DeliveryStatus): LocaleKey {
  return DELIVERY_ADVANCE_LABEL_KEYS[`${from}→${to}`] ?? DELIVERY_STATUS_LABEL_KEYS[to]
}

/** Whether a transition target is clickable (human-invokable AND guard passed). */
export function deliveryTargetInvokable(target: DeliveryTargetTransition): boolean {
  return target.humanAction && target.guard === 'satisfied'
}

/** Whether a target is the human rework edge `verifying → integrating`. */
export function isDeliveryReworkTarget(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return from === 'verifying' && to === 'integrating'
}

/** Whether a target is the verification-confirmation edge `verifying → verified`. */
export function isVerificationConfirmTarget(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return from === 'verifying' && to === 'verified'
}

/**
 * The gaps a delivery's plan surfaces, in guard order (branch → integration →
 * confirm → merge), de-duplicated by reason code. Drives the persistent gap
 * list under the status selector; the N/M figure rides in the same block.
 */
export function deliveryGapReasons(plan: DeliveryTransitionPlan): DeliveryGuardReason[] {
  const seen = new Set<string>()
  const out: DeliveryGuardReason[] = []
  for (const target of plan.targets) {
    for (const reason of target.reasons) {
      if (seen.has(reason.code)) continue
      seen.add(reason.code)
      out.push(reason)
    }
  }
  return out
}

/** Whether a delivery sits in a terminal state (no progress targets). */
export function isDeliveryTerminal(status: DeliveryStatus): boolean {
  return status === 'delivered' || status === 'cancelled'
}

/**
 * Calendar-date (YYYY-MM-DD, UTC) → epoch ms. The wire stores the user's chosen
 * calendar date as a UTC-midnight epoch; `epochMsToCalendarDate` is its inverse.
 */
export function calendarDateToEpochMs(value: string): number {
  return Date.parse(`${value}T00:00:00Z`)
}

/**
 * The LOCAL calendar date ('YYYY-MM-DD') of `at` — the day the user is actually
 * on. Feed it to `calendarDateToEpochMs` to get the wire value; taking the local
 * midnight timestamp instead would encode the previous day in any positive
 * offset (UTC+8 midnight is 16:00Z of the day before), which
 * `epochMsToCalendarDate` would then render back as "yesterday".
 */
export function localCalendarDate(at: Date): string {
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Epoch ms → 'YYYY-MM-DD' (UTC); `null`/`0`/NaN → '' (no real calendar date is epoch 0). */
export function epochMsToCalendarDate(ms: number | null | undefined): string {
  if (ms == null || ms === 0 || !Number.isFinite(ms)) return ''
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The default delivery branch name a user can edit before initializing:
 * `delivery/<short-id>-<slug>` — the same slug rule as the intent branch name
 * (`server/src/features/intents/worktree.ts` `generateBranchName`), with the
 * `delivery/` prefix. `short-id` = first 8 hex chars of the UUID; slug = lowered,
 * quotes stripped, non-alphanumerics → dashes, trimmed, capped at 48 chars.
 */
export function defaultDeliveryBranchName(deliveryId: string, title: string): string {
  const shortId = deliveryId.replace(/-/g, '').slice(0, 8)
  const slug = title
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `delivery/${shortId}-${slug}`
}

/**
 * What the intent page's 「当前意图独立交付」 hands upward: the intent's own facts,
 * verbatim. The calendar day is NOT part of it — the control layer stamps it, so
 * the encoding rule (local calendar day → UTC-midnight epoch) lives in exactly
 * one place instead of in every emitter.
 */
export interface StandaloneDeliveryRequest {
  workspaceId: string
  intentId: string
  /** The new delivery's title = the intent's title. */
  title: string
  /** The new delivery's description = the intent's content. */
  description: string
}

/** One coarse phase boundary of an `init_delivery_branch` run (wire mirror). */
export type DeliveryBranchInitPhase = 'fetching' | 'creating' | 'pushing' | 'binding'

/**
 * The client-side in-flight state of a branch-init run: which delivery's branch
 * is being initialized and the latest reported phase. Drives the init form's
 * progress line + disabled button; `null` = no run in flight.
 */
export interface DeliveryBranchInitState {
  deliveryId: string
  phase: DeliveryBranchInitPhase
}
