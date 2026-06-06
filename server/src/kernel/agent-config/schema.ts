/**
 * Runtime (zod) validation for the `vendor`-discriminated {@link AgentConfig}
 * (ADR-0011's vendor dimension applied to the config layer). The **type** lives
 * in `shared/protocol.ts` (zero-runtime, SDK-free — ADR-0009); the **runtime
 * schema** lives here so zod never enters the wire module. A type-level
 * assertion at the bottom pins the two together so they cannot drift (the same
 * discipline `AdapterCapability` ↔ `AdapterCapabilities` uses).
 *
 * Today only `claude` has a real adapter (ADR-0011 reference) and thus a config
 * shape. `codex`/`opencode` are the **extension point**: a new vendor adds its
 * `z.object` arm to {@link VENDOR_AGENT_SCHEMAS}, appends it to the
 * {@link agentConfigSchema} union, and the type pin forces the matching wire arm
 * in `shared/protocol.ts`. Until then their configs simply fail to parse — the
 * normalize layer drops them (fail-soft), matching the registry reality where
 * only `claude` has a factory.
 */
import { z } from 'zod'
import type { AgentConfig, VendorId } from '@ccc/shared/protocol'

/** The vendor-agnostic public shell shared by every agent arm. */
const baseShellSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  enabled: z.boolean().optional(),
  icon: z.string().optional(),
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

/** The `opencode` vendor's config sub-object (provider launch overrides). */
export const opencodeConfigSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
})

/** The `opencode` agent arm: public shell + `vendor: 'opencode'` + opencode config. */
const opencodeAgentSchema = baseShellSchema.extend({
  vendor: z.literal('opencode'),
  config: opencodeConfigSchema,
})

/**
 * Per-vendor agent-arm schema registry — the **extension point**. A new vendor
 * registers its arm here (and in {@link agentConfigSchema} below). Partial over
 * {@link VendorId} on purpose: a vendor without an entry has no config shape yet
 * and cannot be persisted as an agent (it would have no adapter to run on).
 * `claude` + `opencode` have real adapters; `codex` remains unregistered.
 */
export const VENDOR_AGENT_SCHEMAS = {
  claude: claudeAgentSchema,
  opencode: opencodeAgentSchema,
} satisfies Partial<Record<VendorId, z.ZodTypeAny>>

/**
 * The full {@link AgentConfig} schema, routed by the `vendor` discriminant:
 * `safeParse` dispatches an object to its vendor's arm and rejects an unknown
 * vendor or a config that fails that arm. claude + opencode arms today; new
 * vendors append their arm.
 */
export const agentConfigSchema = z.discriminatedUnion('vendor', [
  claudeAgentSchema,
  opencodeAgentSchema,
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
