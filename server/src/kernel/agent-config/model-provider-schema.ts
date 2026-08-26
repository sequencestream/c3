/**
 * Runtime (zod) validation for {@link ModelProvider} / {@link ProviderConnection}
 * / {@link ModelProviderModel}. The **types** live in `shared/protocol/model-provider.ts`
 * (zero-runtime, SDK-free); the **runtime schema** lives here so zod never enters the
 * wire module. A type-level assertion at the bottom pins the two together so they
 * cannot drift (the same discipline `agentConfigSchema` ↔ `AgentConfig` uses).
 */

import { z } from 'zod'
import type { ModelProvider, ModelProviderModel, ProviderConnection } from '@ccc/shared/protocol'
import { VENDOR_IDS } from '@ccc/shared/protocol'

/** One model entry in a provider's optional model catalog. */
export const modelProviderModelSchema = z.object({
  id: z.string(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
})

/**
 * One vendor's connection inside a provider. `baseUrl` is required for the
 * connection to be "usable"; `apiKey` is optional (falls back to the provider's
 * account-level key); `wireApi` is codex-only and defaults to `'chat'` when absent.
 */
export const providerConnectionSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  wireApi: z.enum(['responses', 'chat']).optional(),
})

/**
 * The vendor-keyed connections map. Only known vendors may appear; an unknown vendor
 * key is dropped (fail-soft) rather than rejecting the whole provider. The value is
 * a {@link ProviderConnection}; `z.record` accepts any string key, so we filter to
 * known vendors in `parseModelProvider` below.
 */
const connectionsRecordSchema = z.record(z.string(), providerConnectionSchema)

/**
 * The full {@link ModelProvider} schema. `id` and `displayName` are required;
 * `apiKey` may be empty (when every connection carries its own key); `connections`
 * defaults to an empty map; `models` is optional; `paused` defaults to false.
 *
 * The zod layer does NOT enforce "at least one usable connection" — that is a
 * business invariant the console warns about but the store accepts (a provider may
 * be saved half-configured and completed later).
 */
export const modelProviderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  template: z.string().optional(),
  apiKey: z.string().default(''),
  connections: connectionsRecordSchema.default({}),
  models: z.array(modelProviderModelSchema).optional(),
  paused: z.boolean().optional(),
})

/**
 * Validate + normalize one candidate model-provider object. Returns the typed
 * {@link ModelProvider} on success, or `null` when the object fails the schema (the
 * normalize layer drops a `null`, fail-soft).
 *
 * Post-processing:
 *  - trims `displayName` and `template`
 *  - filters `connections` to known vendors only (unknown keys dropped with a warning)
 *  - trims each connection's `baseUrl`
 *  - ensures `apiKey` is a string (zod default handles missing, but a non-string
 *    from a hand-edited file is caught by safeParse)
 */
export function parseModelProvider(raw: unknown): ModelProvider | null {
  const result = modelProviderSchema.safeParse(raw)
  if (!result.success) return null
  const p = result.data

  // Filter connections to known vendors; warn about unknown keys (hand-edited file).
  const filtered: Partial<Record<string, ProviderConnection>> = {}
  for (const [vendor, conn] of Object.entries(p.connections)) {
    if ((VENDOR_IDS as readonly string[]).includes(vendor)) {
      filtered[vendor] = { ...conn, baseUrl: conn.baseUrl.trim() }
    } else {
      console.warn(
        `[c3] modelProvider "${p.id}" carries connection for unknown vendor "${vendor}" — dropping.`,
      )
    }
  }

  return {
    id: p.id,
    displayName: p.displayName.trim(),
    ...(p.template !== undefined ? { template: p.template.trim() } : {}),
    apiKey: p.apiKey,
    connections: filtered,
    ...(p.models !== undefined ? { models: p.models } : {}),
    ...(p.paused !== undefined ? { paused: p.paused } : {}),
  }
}

// ---- Type pin: the zod schema's inferred type IS the wire ModelProvider ----
type _AssertExtends<A extends B, B> = A & B
type _PinSchemaIsWire = _AssertExtends<z.infer<typeof modelProviderSchema>, ModelProvider>
type _PinWireIsSchema = _AssertExtends<ModelProvider, z.infer<typeof modelProviderSchema>>
export type __ModelProviderSchemaPin = [_PinSchemaIsWire, _PinWireIsSchema]
