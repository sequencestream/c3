/**
 * Runtime (zod) validation for {@link ModelProvider} / {@link ModelProviderModel}.
 * The **types** live in `shared/protocol/model-provider.ts` (zero-runtime, SDK-free);
 * the **runtime schema** lives here so zod never enters the wire module. A type-level
 * assertion at the bottom pins the two together so they cannot drift (the same
 * discipline `agentConfigSchema` ↔ `AgentConfig` uses).
 *
 * Also accepts the legacy `connections: Record<VendorId, { baseUrl, apiKey?, wireApi? }>`
 * shape on load and folds it into `urls` + account `apiKey` + `wireApi`, so a config
 * written before the protocol-keyed rewrite still boots.
 */

import { z } from 'zod'
import type { ModelProvider, ProtocolType } from '@ccc/shared/protocol'
import { PROTOCOL_TYPES } from '@ccc/shared/protocol'

/**
 * `v-model.number` on a cleared `<input type="number">` writes back `''` (Vue's
 * `looseToNumber` leaves non-numeric strings alone rather than coercing to
 * `undefined`), so a positive-int schema must tolerate the empty string the
 * console can legitimately produce — otherwise one cleared field fails the whole
 * `modelProviderSchema` parse and normalize's fail-soft branch drops the entire
 * provider (URL + account key included), not just the one bad field.
 */
function optionalPositiveInt() {
  return z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? undefined : v),
    z.number().int().positive().optional(),
  )
}

/** One model entry in a provider's optional model catalog. */
export const modelProviderModelSchema = z.object({
  id: z.string(),
  contextWindow: optionalPositiveInt(),
  maxOutputTokens: optionalPositiveInt(),
})

/** Per-protocol URL map. Unknown keys are dropped in {@link parseModelProvider}. */
const urlsRecordSchema = z
  .object({
    openai: z.string().optional(),
    anthropic: z.string().optional(),
  })
  .catchall(z.string())
  .default({})

/**
 * Legacy per-vendor connection blob. Kept only so load can migrate it; never written
 * back. `z.record` accepts any string key — filtered below.
 */
const legacyConnectionSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  wireApi: z.enum(['responses', 'chat']).optional(),
})

/**
 * The full {@link ModelProvider} schema. `connections` is accepted as a legacy alias
 * for migration and stripped before the typed result is returned.
 */
export const modelProviderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  template: z.string().optional(),
  apiKey: z.string().default(''),
  urls: urlsRecordSchema,
  connections: z.record(z.string(), legacyConnectionSchema).optional(),
  wireApi: z.enum(['responses', 'chat']).optional(),
  models: z.array(modelProviderModelSchema).optional(),
  synthesized: z.boolean().optional(),
  paused: z.boolean().optional(),
})

/** Map a legacy VendorId connection key onto a ProtocolType. */
const LEGACY_VENDOR_TO_PROTOCOL: Record<string, ProtocolType> = {
  claude: 'anthropic',
  codex: 'openai',
}

/**
 * Validate + normalize one candidate model-provider object. Returns the typed
 * {@link ModelProvider} on success, or `null` when the object fails the schema (the
 * normalize layer drops a `null`, fail-soft).
 *
 * Post-processing:
 *  - trims `displayName` and `template`
 *  - folds legacy `connections` into `urls` / account `apiKey` / `wireApi`
 *  - filters `urls` to known protocol types only
 *  - trims each URL
 */
export function parseModelProvider(raw: unknown): ModelProvider | null {
  const result = modelProviderSchema.safeParse(raw)
  if (!result.success) return null
  const p = result.data

  const urls: Partial<Record<ProtocolType, string>> = {}
  let apiKey = p.apiKey
  let wireApi = p.wireApi

  // New shape first — preserve empty slots so「勾选协议、稍后填 URL」 survives save.
  for (const [key, value] of Object.entries(p.urls)) {
    if ((PROTOCOL_TYPES as readonly string[]).includes(key)) {
      urls[key as ProtocolType] = value.trim()
    } else {
      console.warn(
        `[c3] modelProvider "${p.id}" carries url for unknown protocol "${key}" — dropping.`,
      )
    }
  }

  // Legacy connections → urls. Only fills slots the new shape left empty; folds a
  // blank account key from the first non-empty per-vendor override.
  if (p.connections) {
    for (const [vendor, conn] of Object.entries(p.connections)) {
      const protocol = LEGACY_VENDOR_TO_PROTOCOL[vendor]
      if (!protocol) {
        console.warn(
          `[c3] modelProvider "${p.id}" carries legacy connection for unknown vendor "${vendor}" — dropping.`,
        )
        continue
      }
      const trimmed = conn.baseUrl.trim()
      if (trimmed && !urls[protocol]) urls[protocol] = trimmed
      const connKey = conn.apiKey?.trim()
      if (connKey) {
        if (!apiKey.trim()) {
          apiKey = connKey
        } else if (apiKey !== connKey) {
          console.warn(
            `[c3] modelProvider "${p.id}" legacy connections carry different apiKeys (vendor "${vendor}") — keeping the first, dropping the override.`,
          )
        }
      }
      if (protocol === 'openai' && wireApi === undefined && conn.wireApi) {
        wireApi = conn.wireApi
      }
    }
  }

  return {
    id: p.id,
    displayName: p.displayName.trim(),
    ...(p.template !== undefined ? { template: p.template.trim() } : {}),
    apiKey,
    urls,
    ...(wireApi !== undefined ? { wireApi } : {}),
    ...(p.models !== undefined ? { models: p.models } : {}),
    ...(p.synthesized !== undefined ? { synthesized: p.synthesized } : {}),
    ...(p.paused !== undefined ? { paused: p.paused } : {}),
  }
}

// ---- Type pin: parsed output and wire `ModelProvider` must stay aligned ----
type _AssertExtends<A extends B, B> = A & B
type _ModelProviderSchemaCore = Omit<z.infer<typeof modelProviderSchema>, 'connections'>
type _PinSchemaIsWire = _AssertExtends<_ModelProviderSchemaCore, ModelProvider>
type _PinWireIsSchema = _AssertExtends<ModelProvider, _ModelProviderSchemaCore>
type _PinParsedIsWire = _AssertExtends<ReturnType<typeof parseModelProvider>, ModelProvider | null>
export type __ModelProviderSchemaPin = [_PinSchemaIsWire, _PinWireIsSchema, _PinParsedIsWire]
