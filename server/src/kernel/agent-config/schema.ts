/**
 * Runtime (zod) validation for the `vendor`-discriminated {@link AgentConfig}
 * (ADR-0011's vendor dimension applied to the config layer). The **type** lives
 * in `shared/protocol.ts` (zero-runtime, SDK-free — ADR-0009); the **runtime
 * schema** lives here so zod never enters the wire module. A type-level
 * assertion at the bottom pins the two together so they cannot drift (the same
 * discipline `AdapterCapability` ↔ `AdapterCapabilities` uses).
 *
 * Claude and Codex have config shapes. A new vendor adds its `z.object` arm to
 * {@link VENDOR_AGENT_SCHEMAS}, appends it to the {@link agentConfigSchema}
 * union, and the type pin forces the matching wire arm in `shared/protocol.ts`.
 */
import { z } from 'zod'
import type { AgentConfig, VendorId } from '@ccc/shared/protocol'

/** The vendor-agnostic public shell shared by every agent arm. */
const baseShellSchema = z.object({
  id: z.string(),
  // Provider-config source, orthogonal to vendor (2026-06-06-007): `system` ⇒ use
  // the vendor CLI's own config (no provider overrides); `custom` ⇒ apply the
  // config provider triple. The migrate layer infers it for legacy records.
  configMode: z.enum(['system', 'custom']),
  displayName: z.string(),
  enabled: z.boolean().optional(),
  icon: z.string().optional(),
  // User-controlled global sort position (regularized to a dense 0..n sequence by
  // the server `normalize`). Optional on the wire — a legacy record without it is
  // backfilled by array order; the matching wire field is `order_seq?: number`.
  order_seq: z.number().optional(),
  // Group membership (ADR-0029): non-empty ⇒ this agent joins the `(group, vendor)`
  // group exposed as the virtual `_c3_<group>` agent. Optional on the wire.
  group: z.string().optional(),
})

/** The `claude` vendor's config sub-object (the Claude Code launch overrides). */
export const claudeConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
})

/** The `claude` agent arm: public shell + `vendor: 'claude'` + claude config. */
const claudeAgentSchema = baseShellSchema.extend({
  vendor: z.literal('claude'),
  config: claudeConfigSchema,
})

/**
 * The `codex` vendor's config sub-object (2026-06-06-005). The neutral provider
 * triple only: Codex's launch-time policy gate (`sandboxMode`/`approvalPolicy`) is
 * NOT persisted — it is derived at launch from the session `defaultMode`
 * (2026-06-06-008), so the codex arm mirrors claude exactly.
 */
export const codexConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  // Declares the custom provider's upstream protocol so the driver routes DIRECT
  // vs RELAY deterministically (see CodexAgentConfig). `.default('chat')` migrates
  // a legacy record without the field to the relay path — preserving the
  // pre-2026-06-12-006 third-party-via-relay behaviour — and keeps the inferred
  // OUTPUT type required, matching the wire `CodexAgentConfig`.
  wireApi: z.enum(['responses', 'chat']).default('chat'),
})

/** The `codex` agent arm: public shell + `vendor: 'codex'` + codex config. */
const codexAgentSchema = baseShellSchema.extend({
  vendor: z.literal('codex'),
  config: codexConfigSchema,
})

/**
 * Per-vendor agent-arm schema registry — the **extension point**. A new vendor
 * registers its arm here (and in {@link agentConfigSchema} below). Partial over
 * {@link VendorId} on purpose: a vendor without an entry has no config shape yet
 * and cannot be persisted as an agent (it would have no adapter to run on).
 * `claude` and `codex` have real adapters.
 */
export const VENDOR_AGENT_SCHEMAS = {
  claude: claudeAgentSchema,
  codex: codexAgentSchema,
} satisfies Partial<Record<VendorId, z.ZodTypeAny>>

/**
 * The full {@link AgentConfig} schema, routed by the `vendor` discriminant:
 * `safeParse` dispatches an object to its vendor's arm and rejects an unknown
 * vendor or a config that fails that arm. claude + codex arms; new
 * vendors append their arm.
 */
export const agentConfigSchema = z.discriminatedUnion('vendor', [
  claudeAgentSchema,
  codexAgentSchema,
])

/**
 * Validate + route one candidate agent object by its `vendor` tag. Returns the
 * typed {@link AgentConfig} on success, or `null` when the vendor is unknown or
 * the config fails its arm (the normalize layer drops a `null`, fail-soft).
 */
export function parseAgentConfig(raw: unknown): AgentConfig | null {
  const result = agentConfigSchema.safeParse(raw)
  return result.success ? result.data : null
}

// ---- Type pin: the zod schema's inferred type IS the wire `AgentConfig` ----
// Both directions must hold; either failing is a compile error, so the runtime
// schema and the zero-runtime wire type can never drift.
type _AssertExtends<A extends B, B> = A & B
type _PinSchemaIsWire = _AssertExtends<z.infer<typeof agentConfigSchema>, AgentConfig>
type _PinWireIsSchema = _AssertExtends<AgentConfig, z.infer<typeof agentConfigSchema>>
// Reference the aliases so `noUnusedLocals`/lint do not flag them.
export type __AgentConfigSchemaPin = [_PinSchemaIsWire, _PinWireIsSchema]
