/**
 * The impact-level → spec-gate policy, as ONE set of pure, side-effect-free
 * judgements.
 *
 * `impactLevel` says how far a change reaches; the spec gate says how hard the
 * change is checked before development starts. Wiring the two together means the
 * widest blast radius is always checked hardest — and never slips past on a
 * workspace default or an automation opt-in:
 *
 * - L1/L2 (high impact): the effective spec mode is FORCED to `sdd`, the spec
 *   must be approved BY A HUMAN before any development turn starts, and the
 *   machine may never approve it — regardless of the workspace SDD switch or the
 *   explicit `fast` override.
 * - L3 / ungraded: keep the existing rule — an explicit mode wins, a `null`
 *   inherits the workspace (`sdd` on, `fast` off). No impact-level override.
 * - L4/L5 (low impact): a `null` mode defaults to `fast` (spec deferred), an
 *   explicit `sdd`/`fast` still wins. The machine-approval opt-in is NOT relaxed
 *   by the grade.
 *
 * Machine eligibility is not "approve now": it only says the grade does not veto
 * a machine approval. The queue still requires a pending spec, a valid `pass`
 * conclusion, a matching fingerprint, and no human veto before it emits one.
 *
 * This lives in `@ccc/shared` next to {@link evaluateDependencyGate} because it
 * has THREE readers that must agree — the queue reconcile kernel (which is a pure
 * function and must not import the features layer), the manual admission gate,
 * and the UI's action/mode projection. One table, one file, no per-reader copy.
 *
 * Data in, verdict out: no I/O, no clock, no store access.
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
  specApproveUser: string | null
}

/**
 * Whether the spec gate still BLOCKS development (`true`) or admits it (`false`).
 *
 * - `fast` never blocks — the spec is reverse-authored after the turn.
 * - High impact blocks until the spec is `approved` AND approved by a human: a
 *   machine approval is not enough, and this holds even when the workspace has
 *   SDD switched off (a high-impact change cannot dodge the checkpoint by
 *   turning the workspace default off).
 * - Otherwise an `sdd` intent blocks while `sddEnabled` and the spec is not yet
 *   `approved`; an explicit `sdd` in a workspace with SDD off does NOT start a
 *   spec stage (that workspace keeps its spec-less behaviour).
 */
export function specGateBlocks(facts: SpecGateFacts): boolean {
  if (facts.effectiveSpecMode === 'fast') return false
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
