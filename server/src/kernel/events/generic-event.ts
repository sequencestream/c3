/**
 * Generic event publish layer (kernel).
 *
 * The vendor-neutral counterpart to a growing set of model-publishable events.
 * Instead of one bespoke payload + one narrow MCP tool per topic, a producer
 * hands a {@link GenericEvent} core to this layer; the layer looks the event's
 * `type` up in a `type → normalizer` registry, runs the registered normalizer
 * (which validates that type's semantics and performs FIELD-LEVEL redaction /
 * truncation), and only then is the event eligible for the bus.
 *
 * ── Why a registry (intentional revision of the old "no polymorphic publish_event")
 *   The prior stance was "add a new narrow tool per event type" to keep field-level
 *   type-safety + field-level safety normalization. This layer keeps BOTH the
 *   generality (one publish path) AND the safety (per-type normalizer): a known
 *   `type` gets its dedicated typed normalizer, while any OTHER (custom) `type`
 *   falls through to an optional DEFAULT normalizer. The default still enforces the
 *   safety pillar (structural secret redaction + truncation) — it just isn't tied
 *   to a fixed field shape — so the open `<category>:<action>` contract holds
 *   (a `custom:*` event publishes) without degrading into raw passthrough. When no
 *   default is wired, an unregistered type is still rejected outright.
 *
 * ── Boundary (ADR-0009 R1)
 *   This module lives in `kernel/` and MUST NOT import from `features/` or
 *   `transport/`. The concrete per-type normalizers are FEATURE code, registered
 *   explicitly at the composition root; the registry itself is feature-agnostic.
 *
 * ── Failure semantics
 *   A missing normalizer, an invalid core, a normalizer that throws, or a
 *   normalized result that is itself invalid / changed the `type` all resolve to
 *   a `{ ok: false, reason }` — WITHOUT publishing anything. Pre-publish failure
 *   is NOT covered by the bus's subscriber error-isolation (ADR-0018): it happens
 *   before any `EventBus.publish`. The `reason` is machine-friendly and never
 *   echoes the raw (possibly sensitive) input value.
 */
import type { GenericEvent } from '@ccc/shared/protocol'
import { validateGenericEvent } from '@ccc/shared/protocol'

/**
 * A per-type normalizer. Receives the UNTRUSTED (but structurally valid) generic
 * event core and returns a publishable {@link GenericEvent}: it validates the
 * type's semantics, redacts secrets / strips absolute paths, truncates fields,
 * and drops empty structures. It MUST throw on a semantically invalid core and
 * MUST NOT change the event's `type`.
 */
export type EventNormalizer = (core: GenericEvent) => GenericEvent

/** The outcome of normalizing a core through the registry (no bus involved). */
export type NormalizeResult = { ok: true; event: GenericEvent } | { ok: false; reason: string }

/**
 * The kernel `type → normalizer` registry. A registered normalizer is the gate
 * through which an event of that type may be published; a type WITHOUT a dedicated
 * normalizer falls through to the optional `defaultNormalizer` (custom/open types),
 * or — when no default was supplied — is rejected. Registering a duplicate type is
 * a startup configuration error (throws), because the registry must be assembled
 * deterministically before any publish entry point runs.
 */
export class EventNormalizerRegistry {
  private readonly normalizers = new Map<string, EventNormalizer>()

  /**
   * @param defaultNormalizer Fallback for a `type` with no dedicated normalizer.
   *   Omit to keep the registry a CLOSED set (unregistered type → rejected).
   */
  constructor(private readonly defaultNormalizer?: EventNormalizer) {}

  /** Register the normalizer for `type`. Throws on an empty or duplicate type. */
  register(type: string, normalizer: EventNormalizer): void {
    if (typeof type !== 'string' || type.trim() === '') {
      throw new Error('[EventNormalizerRegistry] event type must be a non-empty string')
    }
    if (this.normalizers.has(type)) {
      throw new Error(`[EventNormalizerRegistry] duplicate normalizer for event type "${type}"`)
    }
    this.normalizers.set(type, normalizer)
  }

  /** Whether a normalizer is registered for `type`. */
  has(type: string): boolean {
    return this.normalizers.has(type)
  }

  /**
   * Validate + normalize an untrusted core through the registered (or default)
   * normalizer. Never throws. Returns a failure (and publishes NOTHING — the caller
   * must not proceed) when the core is invalid, its `type` has neither a registered
   * nor a default normalizer, the normalizer throws, or the normalized result is
   * invalid / changed `type`.
   */
  normalize(core: GenericEvent): NormalizeResult {
    const parsed = validateGenericEvent(core)
    if (!parsed.ok) return { ok: false, reason: `invalid event: ${parsed.reason}` }

    const { type } = parsed.value
    const normalizer = this.normalizers.get(type) ?? this.defaultNormalizer
    if (!normalizer)
      return { ok: false, reason: `no normalizer registered for event type "${type}"` }

    let normalized: GenericEvent
    try {
      normalized = normalizer(parsed.value)
    } catch {
      // Never surface the thrown error's message — it may quote the raw value.
      return { ok: false, reason: `normalizer for event type "${type}" rejected the event` }
    }

    const revalidated = validateGenericEvent(normalized)
    if (!revalidated.ok) {
      return { ok: false, reason: `normalizer for event type "${type}" produced an invalid event` }
    }
    if (revalidated.value.type !== type) {
      return {
        ok: false,
        reason: `normalizer for event type "${type}" must not change the event type`,
      }
    }
    return { ok: true, event: revalidated.value }
  }
}
