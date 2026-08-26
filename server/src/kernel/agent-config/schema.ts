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
import { deriveConfigMode } from '@ccc/shared/protocol'

/** Per-model override schema — matches the wire `ModelOverride` type. */
const modelOverrideSchema = z.object({
  model: z.string(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
})

/** The vendor-agnostic public shell shared by every agent arm. */
const baseShellSchema = z.object({
  id: z.string(),
  // Provider-config source, orthogonal to vendor. Derived from `providerId` by
  // normalize but retained on the wire for back-compat readers; zod accepts either
  // value and normalize overwrites with the derived one.
  configMode: z.enum(['system', 'custom']),
  displayName: z.string(),
  enabled: z.boolean().optional(),
  icon: z.string().optional(),
  // User-controlled global sort position (regularized to a dense 0..n sequence by
  // the server `normalize`). Optional on the wire — a legacy record without it is
  // backfilled by array order; the matching wire field is `order_seq?: number`.
  order_seq: z.number().optional(),
  // Group membership: non-empty ⇒ this agent joins the `(group, vendor)` group.
  // Optional on the wire.
  group: z.string().optional(),
  // Reference to a named ModelProvider that supplies this agent's upstream
  // connection. Empty/absent ⇒ use the vendor CLI's own login or legacy inline
  // config. Cursor never carries a providerId (stripped by normalize).
  providerId: z.string().optional(),
  // Optional per-model overrides (context window / max output tokens).
  modelOverrides: z.array(modelOverrideSchema).optional(),
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
  // Optional model-capability fields (2026-08-08-013): when present, the codex
  // driver's relay branch registers the model in a local catalog so codex stops
  // falling back to default metadata for an id it does not know. Absent ⇒ no
  // catalog, current behaviour. Positive integers only — a bad value fails this
  // arm, and the fail-soft normalize drops the whole agent (see the spec's
  // numeric-boundary note).
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
})

/** The `codex` agent arm: public shell + `vendor: 'codex'` + codex config. */
const codexAgentSchema = baseShellSchema.extend({
  vendor: z.literal('codex'),
  config: codexConfigSchema,
})

/**
 * The `cursor` vendor's config sub-object — a key and a model, no base URL. The
 * key is optional: an empty key defers to `CURSOR_API_KEY` in the server
 * environment and then to the CLI's own keychain login, and an empty model to
 * Cursor's own `auto` selection.
 *
 * `.strict()` keeps `baseUrl` out: c3 has no relay speaking Cursor's protocol, so
 * a stored base URL is rejected rather than silently ignored — which is what
 * keeps "cursor cannot be pointed elsewhere" true on disk.
 */
export const cursorConfigSchema = z
  .object({ apiKey: z.string().default(''), model: z.string().default('') })
  .strict()

/**
 * The `cursor` agent arm: public shell + `vendor: 'cursor'` + empty config.
 *
 * The arm keeps the shared shell's `configMode` type so it stays structurally
 * assignable to the wire union. Cursor cannot consume an injected provider, so
 * `custom` is meaningless for it; {@link parseAgentConfig} pins the field to
 * `'system'` on the way in, which fixes a hand-edited settings file at the disk
 * boundary rather than letting the run fail later with a confusing auth error.
 */
const cursorAgentSchema = baseShellSchema.extend({
  vendor: z.literal('cursor'),
  config: cursorConfigSchema,
})

/**
 * Per-vendor agent-arm schema registry — the **extension point**. A new vendor
 * registers its arm here (and in {@link agentConfigSchema} below). Partial over
 * {@link VendorId} on purpose: a vendor without an entry has no config shape yet
 * and cannot be persisted as an agent (it would have no adapter to run on).
 * `claude`, `codex` and `cursor` have real adapters.
 */
export const VENDOR_AGENT_SCHEMAS = {
  claude: claudeAgentSchema,
  codex: codexAgentSchema,
  cursor: cursorAgentSchema,
} satisfies Partial<Record<VendorId, z.ZodTypeAny>>

/**
 * The full {@link AgentConfig} schema, routed by the `vendor` discriminant:
 * `safeParse` dispatches an object to its vendor's arm and rejects an unknown
 * vendor or a config that fails that arm. claude + codex + cursor arms; new
 * vendors append their arm.
 */
export const agentConfigSchema = z.discriminatedUnion('vendor', [
  claudeAgentSchema,
  codexAgentSchema,
  cursorAgentSchema,
])

/**
 * Validate + route one candidate agent object by its `vendor` tag. Returns the
 * typed {@link AgentConfig} on success, or `null` when the vendor is unknown or
 * the config fails its arm (the normalize layer drops a `null`, fail-soft).
 *
 * Post-processing:
 *  - Cursor agents: strip `providerId` (cursor cannot reference a provider) and
 *    force `configMode: 'system'`.
 *  - All agents: recompute `configMode` from `providerId` via `deriveConfigMode`
 *    (the single source of truth — a stale stored value is overwritten).
 */
export function parseAgentConfig(raw: unknown): AgentConfig | null {
  const result = agentConfigSchema.safeParse(raw)
  if (!result.success) return null
  const agent = result.data

  // Cursor cannot reference a provider — strip providerId and force system mode.
  if (agent.vendor === 'cursor') {
    const { providerId: _providerId, ...rest } = agent
    return { ...rest, configMode: 'system' }
  }

  // Recompute configMode from providerId (single source of truth).
  const derivedMode = deriveConfigMode(agent)
  if (agent.configMode !== derivedMode) {
    return { ...agent, configMode: derivedMode }
  }
  return agent
}

// ---- Type pin: the zod schema's inferred type IS the wire `AgentConfig` ----
// Both directions must hold; either failing is a compile error, so the runtime
// schema and the zero-runtime wire type can never drift.
type _AssertExtends<A extends B, B> = A & B
type _PinSchemaIsWire = _AssertExtends<z.infer<typeof agentConfigSchema>, AgentConfig>
type _PinWireIsSchema = _AssertExtends<AgentConfig, z.infer<typeof agentConfigSchema>>
// Reference the aliases so `noUnusedLocals`/lint do not flag them.
export type __AgentConfigSchemaPin = [_PinSchemaIsWire, _PinWireIsSchema]
