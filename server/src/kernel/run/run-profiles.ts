/**
 * Declarative run-profile rules (2026-09-28).
 *
 * A run may be launched under one of several *profiles* — the intent comm agent,
 * the spec author, the spec reviewer, the IM robot — and each one answers two
 * questions the neutral driver path must ask declaratively rather than by
 * re-listing profile names at every decision point:
 *
 *  1. **Does this profile override the session's stored mode grid?** Every
 *     profile does; a profile run's grid comes from the profile, not from
 *     whatever the session happened to be left at.
 *  2. **May this profile carry the session's vendor-private policy through to
 *     the adapter?** None may. A profile run is launched under a locked gate,
 *     so threading a stored native policy in would be a widening the profile
 *     never authorized.
 *
 * Why a table and not `!a && !b && !c`: the boolean conjunction is a *closed
 * list of known profiles*, and a newly added profile is silently ABSENT from it
 * — i.e. the failure direction is "judged eligible to carry native policy".
 * Here the `Record<ProfileKind, ...>` key constraint makes an unregistered kind a
 * COMPILE error instead, and {@link profileRule} additionally falls back
 * conservatively for an unregistered kind that still reaches runtime.
 *
 * This module is the single place a profile name may appear; `run-via-driver`
 * looks rules up and never branches on a profile literal.
 */
import type { NeutralMode, VendorId } from '../agent/adapters/types.js'
import type {
  IntentProfile,
  RobotProfile,
  SpecProfile,
  SpecReviewProfile,
} from './run-via-driver.js'

/**
 * The closed set of run profiles. Adding a member is a type error until the
 * profile is registered in {@link RUN_PROFILE_RULES} — that is the drift pin.
 */
export type ProfileKind = 'intent' | 'spec' | 'spec-review' | 'robot'

/** Which profile-derived grid the driver path must use (never the stored mode). */
export type ProfileGridSource = 'intent' | 'spec' | 'robot'

/** The declarative rule set for one profile kind. */
export interface ProfileRule {
  /** The profile's own gate replaces the session's stored mode grid. */
  readonly overridesMode: boolean
  /**
   * The profile bypasses the session's native vendor policy: a locked-gate run
   * launches from its own grid, so no stored native policy rides along.
   */
  readonly bypassesNativePolicy: boolean
  /** The grid source the driver path resolves for this profile. */
  readonly grid: ProfileGridSource
}

/**
 * Every profile's rule. The `Record<ProfileKind, ...>` constraint is the
 * compile-time full-coverage guarantee: a new {@link ProfileKind} that is not
 * registered here fails `pnpm typecheck`.
 */
export const RUN_PROFILE_RULES: Record<ProfileKind, ProfileRule> = {
  intent: { overridesMode: true, bypassesNativePolicy: true, grid: 'intent' },
  spec: { overridesMode: true, bypassesNativePolicy: true, grid: 'spec' },
  'spec-review': { overridesMode: true, bypassesNativePolicy: true, grid: 'intent' },
  robot: { overridesMode: true, bypassesNativePolicy: true, grid: 'robot' },
}

/**
 * A run with NO profile at all — an ordinary work / discussion session. It
 * overrides nothing, and it is the one case that legitimately carries the
 * session's stored native vendor policy: there is no locked profile gate to
 * contradict.
 */
export const WORK_RUN_RULE: ProfileRule = {
  overridesMode: false,
  bypassesNativePolicy: false,
  grid: 'intent',
}

/**
 * The conservative rule for a kind this build does not know (a caller on a newer
 * protocol, or a hand-built descriptor in a test). Both flags go the SAFE way:
 * do NOT override the session mode, and do NOT carry a native policy. A
 * widening must never be the silent consequence of an unrecognised profile.
 */
export const UNKNOWN_PROFILE_RULE: ProfileRule = {
  overridesMode: false,
  bypassesNativePolicy: true,
  grid: 'intent',
}

/**
 * Look up a profile's rule. Absent profile ⇒ the work-run rule (carry the stored
 * policy); an UNREGISTERED kind ⇒ the conservative rule (carry nothing). The two
 * must differ, or a work run would lose its stored policy and an unknown profile
 * would silently inherit one.
 */
export function profileRule(kind: ProfileKind | undefined): ProfileRule {
  if (!kind) return WORK_RUN_RULE
  return RUN_PROFILE_RULES[kind] ?? UNKNOWN_PROFILE_RULE
}

/**
 * The single profile descriptor `runViaDriver` accepts: a `kind` plus the
 * profile payload for that kind (only the matching one is read). A run is
 * exactly one of intent / spec / spec-review / robot, so the payloads are
 * mutually exclusive by construction.
 */
export interface RunProfile {
  kind: ProfileKind
  intent?: IntentProfile
  spec?: SpecProfile
  specReview?: SpecReviewProfile
  robot?: RobotProfile
}

/** The profile payloads carried by a run descriptor. */
export interface RunProfilePayloads {
  intent?: IntentProfile
  spec?: SpecProfile
  specReview?: SpecReviewProfile
  robot?: RobotProfile
}

/** The profile payload for `kind`, or an empty set when it carries none. */
export function profilePayload(profile: RunProfile | undefined): RunProfilePayloads {
  if (!profile) return {}
  switch (profile.kind) {
    case 'intent':
      return { intent: profile.intent }
    case 'spec':
      return { spec: profile.spec }
    case 'spec-review':
      return { specReview: profile.specReview }
    case 'robot':
      return { robot: profile.robot }
    // An unregistered kind (a newer caller) carries no payload this build knows
    // how to read — return an empty set rather than `undefined`, so the caller's
    // destructure never throws.
    default:
      return {}
  }
}

/** Resolve the grid a profile run launches under. */
export function profileGrid(
  rule: ProfileRule,
  vendor: VendorId,
  robotWriteEnabled: boolean,
  grids: {
    intent: (vendor: VendorId) => NeutralMode
    spec: (vendor: VendorId) => NeutralMode
    robot: (vendor: VendorId, writeEnabled: boolean) => NeutralMode
  },
): NeutralMode {
  switch (rule.grid) {
    case 'intent':
      return grids.intent(vendor)
    case 'spec':
      return grids.spec(vendor)
    case 'robot':
      return grids.robot(vendor, robotWriteEnabled)
  }
}
