/**
 * Delivery state machine — the delivery domain's pure transition core.
 *
 * The single gate every status WRITE funnels through (`canTransitionDelivery`);
 * the server re-evaluates it at write time from current facts (a stale client
 * plan is refused). The client NEVER runs these rules — it only consumes the
 * `transitionPlan` produced here, so reachability and gaps cannot be relaxed
 * on the web side.
 *
 * Graph (6 states):
 *   planned → integrating → verifying → verified → delivered
 *   any non-terminal → cancelled
 *   back edges: verifying → integrating (human rework),
 *               verified → verifying (system only, reason merge_conflict)
 * Terminal states (`delivered`, `cancelled`) have no out-edges.
 *
 * Guards are evaluated in order — branch ready → associated intents' PRs all
 * merged → human verification confirmed → merge succeeded — plus the writer
 * role and, for `verified → verifying`, the required system reason. A failed
 * write returns `delivery.invalidStatusTransition` (edge not in graph) or
 * `delivery.transitionGuardFailed` with the unmet `delivery.guard.*` reasons.
 */
import type {
  Delivery,
  DeliveryGuardReason,
  DeliveryGuardReasonCode,
  DeliveryIntegration,
  DeliveryStatus,
  DeliveryTargetTransition,
  DeliveryTransitionPlan,
} from '@ccc/shared/protocol'

export const DELIVERY_INVALID_TRANSITION = 'delivery.invalidStatusTransition'
export const DELIVERY_TRANSITION_GUARD_FAILED = 'delivery.transitionGuardFailed'

export interface DeliveryTransitionFacts {
  from: DeliveryStatus
  to: DeliveryStatus
  /** Who is performing the write — role gates the system-only edges. */
  role: 'human' | 'system'
  branchReady: boolean
  integration: DeliveryIntegration
  /** Explicit human confirmation required by `verifying → verified`. */
  confirmVerified: boolean
  /** Whether the delivery merge into mainline succeeded (`verified → delivered`). */
  mergeSucceeded?: boolean
  /** Required reason for the system back-edge `verified → verifying`. */
  reason?: 'merge_conflict'
}

export type DeliveryTransitionVerdict =
  | { ok: true }
  | {
      ok: false
      code: typeof DELIVERY_INVALID_TRANSITION | typeof DELIVERY_TRANSITION_GUARD_FAILED
      reasons: DeliveryGuardReason[]
    }

// ---- Guard predicates (each returns the unmet reason, or null when met) ----

// The gap jumps to the delivery's own branch-init section on the overview tab —
// branch init ships with the delivery branch lifecycle, so the user can act on
// the gap from the page itself rather than being sent to workspace settings.
const branchNotReady = (f: DeliveryTransitionFacts): DeliveryGuardReason | null =>
  f.branchReady ? null : { code: 'delivery.guard.branchNotReady', jumpTo: 'branch' }

const integrationNotReady = (f: DeliveryTransitionFacts): DeliveryGuardReason | null => {
  const { total, merged } = f.integration
  if (total === 0)
    return { code: 'delivery.guard.noAssociatedIntents', jumpTo: 'associated-intents' }
  if (merged < total) {
    return {
      code: 'delivery.guard.prsNotMerged',
      params: { merged, total },
      jumpTo: 'associated-intents',
    }
  }
  return null
}

const verificationNotConfirmed = (f: DeliveryTransitionFacts): DeliveryGuardReason | null =>
  f.confirmVerified ? null : { code: 'delivery.guard.verificationNotConfirmed' }

const mergeNotSucceeded = (f: DeliveryTransitionFacts): DeliveryGuardReason | null =>
  f.mergeSucceeded ? null : { code: 'delivery.guard.mergeNotSucceeded' }

interface DeliveryEdge {
  /** The writer role allowed on this edge; the other role is refused. */
  role: 'human' | 'system'
  /** Data guards, evaluated in order; every unmet one becomes a reason. */
  guards: ((f: DeliveryTransitionFacts) => DeliveryGuardReason | null)[]
  /** A reason a system write must supply (only `verified → verifying`). */
  requiresReason?: 'merge_conflict'
}

/**
 * The edge table. `cancelled` is a legal target from every non-terminal state
 * (member cancel); terminal states have no outgoing edges. Table-driven so the
 * 6×6 combo test enumerates it directly.
 */
const EDGES: Record<DeliveryStatus, Partial<Record<DeliveryStatus, DeliveryEdge>>> = {
  planned: {
    integrating: { role: 'human', guards: [branchNotReady] },
    cancelled: { role: 'human', guards: [] },
  },
  integrating: {
    verifying: { role: 'human', guards: [branchNotReady, integrationNotReady] },
    cancelled: { role: 'human', guards: [] },
  },
  verifying: {
    verified: {
      role: 'human',
      guards: [branchNotReady, integrationNotReady, verificationNotConfirmed],
    },
    integrating: { role: 'human', guards: [] }, // human rework — no data guard
    cancelled: { role: 'human', guards: [] },
  },
  verified: {
    delivered: { role: 'system', guards: [mergeNotSucceeded] },
    verifying: { role: 'system', guards: [], requiresReason: 'merge_conflict' },
    cancelled: { role: 'human', guards: [] },
  },
  delivered: {},
  cancelled: {},
}

/**
 * Decide whether `from → to` is writable. Edge not in the graph ⇒
 * `delivery.invalidStatusTransition`; edge legal but role / required reason /
 * any data guard unmet ⇒ `delivery.transitionGuardFailed` with the reasons in
 * guard order. Never writes anything — the caller applies the status only on
 * `ok`.
 */
export function canTransitionDelivery(facts: DeliveryTransitionFacts): DeliveryTransitionVerdict {
  const edge = EDGES[facts.from]?.[facts.to]
  if (!edge) return { ok: false, code: DELIVERY_INVALID_TRANSITION, reasons: [] }
  const reasons: DeliveryGuardReason[] = []
  if (facts.role !== edge.role) {
    reasons.push(
      edge.role === 'system'
        ? { code: 'delivery.guard.systemOnly' }
        : { code: 'delivery.guard.humanOnly' },
    )
  }
  for (const guard of edge.guards) {
    const reason = guard(facts)
    if (reason) reasons.push(reason)
  }
  // A required system write-reason is only meaningful to the matching-role writer:
  // a human viewer of a system-only edge gets the role note + data gaps, not this.
  if (facts.role === edge.role && edge.requiresReason && facts.reason !== edge.requiresReason) {
    reasons.push({ code: 'delivery.guard.mergeConflictReasonRequired' })
  }
  return reasons.length > 0
    ? { ok: false, code: DELIVERY_TRANSITION_GUARD_FAILED, reasons }
    : { ok: true }
}

/** Every status a delivery may move to from `from` (including `cancelled`). */
export function deliveryTargets(from: DeliveryStatus): DeliveryStatus[] {
  return Object.keys(EDGES[from]) as DeliveryStatus[]
}

/** The progress targets a status advances/reworks to — excludes `cancelled`. */
export function deliveryProgressTargets(from: DeliveryStatus): DeliveryStatus[] {
  return deliveryTargets(from).filter((t) => t !== 'cancelled')
}

/**
 * The reachability + gaps a page renders for one delivery's current status.
 * Evaluated for a HUMAN viewer (`confirmVerified` false, `mergeSucceeded`
 * false — those are write-time facts): a human-action edge whose data guards
 * pass reads `satisfied`, everything else reads `failed` with reasons.
 */
export function computeTransitionPlan(delivery: Delivery): DeliveryTransitionPlan {
  const targets: DeliveryTargetTransition[] = deliveryProgressTargets(delivery.status).map((to) => {
    const verdict = canTransitionDelivery({
      from: delivery.status,
      to,
      role: 'human',
      branchReady: delivery.branchReady,
      integration: delivery.integration,
      confirmVerified: false,
      mergeSucceeded: false,
    })
    if (verdict.ok) return { to, humanAction: true, guard: 'satisfied', reasons: [] }
    const humanAction = EDGES[delivery.status][to]!.role === 'human'
    return { to, humanAction, guard: 'failed', reasons: verdict.reasons }
  })
  return { targets }
}

/**
 * Gaps a human action present in the workspace can resolve TODAY, expressed as
 * transition-plan reasons. Empty: every gap the plan can report is either
 * resolved elsewhere on the page (branch init, intent association) or is a pure
 * system wait. The one human action that hangs off a system-only edge — opening
 * or unblocking the delivery PR — is not expressible as a plan reason at all
 * (the plan cannot see whether a PR exists), so it enters the badge through
 * `mergeActionable` instead. Add a code here when a gap becomes directly
 * human-resolvable, and the badge follows the same rule.
 */
const HUMAN_SOLVABLE_GAPS: ReadonlySet<DeliveryGuardReasonCode> = new Set()

/**
 * Whether a delivery needs user attention, per the header-badge rule: an
 * executable human forward/rework action exists, an unresolved human-solvable
 * gap exists, or a delivery-PR action is available. Pure system waits, terminal
 * states and Git actions hidden under `current-branch` never count; the cancel
 * action itself never puts a delivery into the badge.
 *
 * `mergeActionable` is supplied by the caller because it is a LEDGER fact (does a
 * delivery PR exist, is it blocked) that this pure module deliberately cannot
 * read. A `verified` delivery counts when its PR is still to be opened or is
 * 「合并受阻」 — both are things the user can act on; simply waiting for someone
 * to press merge is not.
 */
export function deliveryRequiresAction(
  status: DeliveryStatus,
  targets: DeliveryTargetTransition[],
  mergeActionable = false,
): boolean {
  if (status === 'delivered' || status === 'cancelled') return false
  if (mergeActionable) return true
  if (targets.some((t) => t.humanAction && t.guard === 'satisfied')) return true
  return targets.some((t) => t.reasons.some((r) => HUMAN_SOLVABLE_GAPS.has(r.code)))
}

/**
 * Sum {@link deliveryRequiresAction} over a workspace's deliveries (badge count).
 * `mergeActionable` is the caller's ledger-backed lookup; omitted, no delivery
 * contributes through the delivery-PR route.
 */
export function countDeliveriesNeedingAction(
  items: readonly Delivery[],
  mergeActionable?: (delivery: Delivery) => boolean,
): number {
  return items.reduce(
    (n, d) =>
      n +
      (deliveryRequiresAction(d.status, computeTransitionPlan(d).targets, mergeActionable?.(d))
        ? 1
        : 0),
    0,
  )
}
