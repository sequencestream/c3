/**
 * Per-intent spec-mode persistence guard.
 *
 * The effective-mode POLICY — including the impact-level wiring (L1/L2 force
 * `sdd`, L4/L5 default to `fast`) — lives in `@ccc/shared`
 * (`resolveEffectiveSpecMode` / `specGateBlocks` / `machineApprovalEligible`), so
 * the queue kernel, the manual admission gate and the UI read the SAME table
 * instead of re-deriving it. This module keeps only the persisted-value guard the
 * store narrows untrusted rows with, and re-exports the shared resolver so the
 * existing import path keeps working.
 */
import type { IntentSpecMode } from '@ccc/shared/protocol'
import { INTENT_SPEC_MODES } from '@ccc/shared/protocol'

export { resolveEffectiveSpecMode } from '@ccc/shared'

/** Whether a value is one of the persisted spec-mode constants. */
export function isIntentSpecMode(v: unknown): v is IntentSpecMode {
  return typeof v === 'string' && (INTENT_SPEC_MODES as readonly string[]).includes(v)
}
