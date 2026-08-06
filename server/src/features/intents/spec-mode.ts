/**
 * Per-intent spec-mode derivation — the ONE place the effective mode is
 * resolved from the persisted value plus the workspace SDD switch.
 *
 * Every consumer (the admission gate, the settle-time reverse-spec hook, the
 * shared `Intent` read model) reads the resolved {@link Intent.effectiveSpecMode}
 * carried on the intent rather than re-deriving it, so no two layers can ever
 * disagree. The rule is deliberately small: an explicit persisted `sdd` / `fast`
 * always wins; a `null` (or unknown) value inherits the workspace — SDD on
 * resolves to `sdd`, SDD off to `fast`. SDD off means there is no spec stage or
 * gate at all, so `fast` there merely matches today's spec-off behaviour and
 * never creates a spec.
 */
import type { IntentSpecMode } from '@ccc/shared/protocol'
import { INTENT_SPEC_MODES } from '@ccc/shared/protocol'

/** Whether a value is one of the persisted spec-mode constants. */
export function isIntentSpecMode(v: unknown): v is IntentSpecMode {
  return typeof v === 'string' && (INTENT_SPEC_MODES as readonly string[]).includes(v)
}

/**
 * Resolve the effective spec mode for an intent. `null` / unknown inherits the
 * workspace; an explicit value always wins. Fail-closed direction: an
 * uninterpretable persisted value is treated as unset (inherits), never as an
 * accidental `fast`.
 */
export function resolveEffectiveSpecMode(
  specMode: IntentSpecMode | null | undefined,
  sddEnabled: boolean,
): IntentSpecMode {
  if (specMode !== null && specMode !== undefined) return specMode
  return sddEnabled ? 'sdd' : 'fast'
}
