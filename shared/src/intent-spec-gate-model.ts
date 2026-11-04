/**
 * Shared spec policy for queue scheduling, manual admission and UI actions.
 * High impact forces spec-first; low impact defaults to fast. Review is a
 * separate workspace opt-in: without it an authored spec is sufficient; with
 * it approval is required, and high impact requires a human approver.
 */
import type { IntentImpactLevel, IntentSpecMode, SpecStatus } from './protocol.js'
import { MACHINE_SPEC_APPROVER } from './protocol.js'

/** `true` for L1/L2 — the grades whose change reaches core flow, money or data. */
export function isHighImpactLevel(level: IntentImpactLevel | null | undefined): boolean {
  return level === 'L1' || level === 'L2'
}

/** `true` for L4/L5 — the grades whose change is local / cosmetic. */
export function isLowImpactLevel(level: IntentImpactLevel | null | undefined): boolean {
  return level === 'L4' || level === 'L5'
}

/**
 * Resolve the effective spec mode from the persisted override, the workspace SDD
 * switch and the impact level. The impact-level arms sit OUTSIDE the existing
 * rule so a high-impact grade cannot be bypassed by an explicit `fast` or a
 * switched-off workspace:
 *
 * - high impact forces `sdd`;
 * - low impact with no explicit mode defaults to `fast` (deferred spec);
 * - otherwise the explicit value wins, then the workspace switch decides.
 *
 * Fail-closed direction on the persisted value: an uninterpretable mode reads as
 * unset (inherits / defaults), never as an accidental `fast`.
 */
export function resolveEffectiveSpecMode(
  specMode: IntentSpecMode | null | undefined,
  sddEnabled: boolean,
  impactLevel: IntentImpactLevel | null | undefined = null,
): IntentSpecMode {
  if (isHighImpactLevel(impactLevel)) return 'sdd'
  if (isLowImpactLevel(impactLevel) && (specMode === null || specMode === undefined)) return 'fast'
  if (specMode !== null && specMode !== undefined) return specMode
  return sddEnabled ? 'sdd' : 'fast'
}

/**
 * Whether a stored approver identity is a HUMAN. `null`/empty means no approval
 * at all, and the reserved {@link MACHINE_SPEC_APPROVER} constant means the queue
 * approved it — neither counts as a human for the high-impact gate.
 */
export function isHumanSpecApprover(approveUser: string | null | undefined): boolean {
  return !!approveUser && approveUser !== MACHINE_SPEC_APPROVER
}

/** The facts the spec admission gate reads — nothing else is consulted. */
export interface SpecGateFacts {
  impactLevel: IntentImpactLevel | null
  /** The RESOLVED mode, already reduced from override + workspace + grade. */
  effectiveSpecMode: IntentSpecMode
  sddEnabled: boolean
  specStatus: SpecStatus
  /** Default false: authored specs may proceed without review or approval. */
  specReviewRequired?: boolean
  specApproveUser: string | null
}

/** Whether spec authoring or required approval still blocks development. */
export function specGateBlocks(facts: SpecGateFacts): boolean {
  if (facts.effectiveSpecMode === 'fast') return false
  if (!isHighImpactLevel(facts.impactLevel) && !facts.sddEnabled) return false
  if (facts.specReviewRequired !== true) return facts.specStatus === 'raw'
  if (isHighImpactLevel(facts.impactLevel)) {
    return !(facts.specStatus === 'approved' && isHumanSpecApprover(facts.specApproveUser))
  }
  if (!facts.sddEnabled) return false
  return facts.specStatus !== 'approved'
}

/**
 * Whether the machine may approve this intent's spec AT ALL, given its grade and
 * the workspace's explicit opt-in. High impact is always `false`; every other
 * grade defers entirely to the opt-in (`true` only). `false` here is a veto, not
 * a scheduling decision — a `true` still needs a pending spec, a valid `pass`,
 * a matching fingerprint and no human veto before an approval action exists.
 */
export function machineApprovalEligible(
  impactLevel: IntentImpactLevel | null | undefined,
  machineApprovalEnabled: boolean,
): boolean {
  if (isHighImpactLevel(impactLevel)) return false
  return machineApprovalEnabled === true
}
