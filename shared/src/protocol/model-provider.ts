/**
 * Named model-provider entities: the upstream connection (base URL / apiKey /
 * wireApi) lifted OUT of per-agent inline config so multiple agents can share one
 * provider, and key rotation / endpoint changes touch a single record.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 *
 * Relationship to agents: an agent carries an optional `providerId`; when set, the
 * runtime picks a {@link ProtocolType} from the agent's vendor support list (first
 * protocol that the provider has a non-empty URL for) and uses that URL + the
 * account-level key. An empty `providerId` uses the vendor CLI's own system login.
 *
 * Zero-runtime wire module: no zod, no vendor SDK. The runtime schema lives
 * server-side in `kernel/agent-config/model-provider-schema.ts`.
 */

import type { ProviderVendorId } from '../model-provider-catalog.js'
import type { VendorId } from './vendor.js'

/**
 * Upstream wire-protocol style — what the provider's docs call "OpenAI-compatible"
 * vs "Anthropic-compatible". Distinct from {@link VendorId} (which CLI c3 launches).
 */
export type ProtocolType = 'openai' | 'anthropic'

/** Runtime list of every known {@link ProtocolType}; pinned against the union below. */
export const PROTOCOL_TYPES = ['openai', 'anthropic'] as const satisfies readonly ProtocolType[]

type _PinProtocolTypesCoverUnion =
  Exclude<ProtocolType, (typeof PROTOCOL_TYPES)[number]> extends never
    ? true
    : [
        'PROTOCOL_TYPES is missing a ProtocolType',
        Exclude<ProtocolType, (typeof PROTOCOL_TYPES)[number]>,
      ]
const _pinProtocolTypesCoverUnion: _PinProtocolTypesCoverUnion = true
void _pinProtocolTypesCoverUnion

/**
 * Each vendor's preferred protocol list, in selection order. When an agent binds a
 * provider, the runtime walks this list and takes the **first** protocol for which
 * the provider has a non-empty URL — that URL is the agent's base URL.
 *
 *  - `claude` speaks Anthropic Messages.
 *  - `codex` speaks OpenAI (Chat / Responses; see {@link ModelProvider.wireApi}).
 *  - `cursor` can speak either; openai is preferred when both are present.
 */
export const VENDOR_PROTOCOL_TYPES = {
  claude: ['anthropic'],
  codex: ['openai'],
  cursor: ['openai', 'anthropic'],
} as const satisfies Record<VendorId, readonly [ProtocolType, ...ProtocolType[]]>

/**
 * Pick the protocol an agent of `vendor` should use against `urls`: the first entry
 * in {@link VENDOR_PROTOCOL_TYPES} whose URL is non-empty. `null` ⇒ this provider
 * cannot supply a base URL for that vendor.
 */
export function selectProtocol(
  vendor: VendorId,
  urls: Partial<Record<ProtocolType, string>>,
): ProtocolType | null {
  for (const protocol of VENDOR_PROTOCOL_TYPES[vendor]) {
    if (urls[protocol]?.trim()) return protocol
  }
  return null
}

/**
 * One model entry in a provider's optional model catalog. Used purely as a
 * pre-fill source when creating a new agent bound to this provider; NOT a runtime
 * default fallback (an agent's own `config.model` always wins).
 */
export interface ModelProviderModel {
  /** Model id or alias (e.g. `gpt-4o`, `claude-sonnet-4-5`). */
  id: string
  /** Optional context window (tokens) for this model. */
  contextWindow?: number
  /** Optional max output tokens for this model. */
  maxOutputTokens?: number
}

/**
 * A named model-provider entity — the shared upstream connection record agents
 * reference via `providerId`. Lifting the connection out of per-agent config means
 * a key rotation or endpoint migration edits one row instead of N agents.
 *
 * Persisted in `SystemSettings.modelProviders` (alongside `agents`), encrypted at
 * rest for the key fields, plaintext on the wire.
 */
export interface ModelProvider {
  /**
   * Stable id. Minted with the same scheme as agent ids (`<millisecond timestamp>-<counter>`)
   * so the two registries share a creation helper and never collide; never rewritten
   * afterwards.
   */
  id: string
  /** Human-chosen display name (free text, trimmed). */
  displayName: string
  /**
   * Optional template id this provider was seeded from (e.g. a directory preset
   * like `openai`, `anthropic`, `deepseek`). Purely informational — the console uses
   * it to show "created from template X" and to offer re-apply; the runtime never
   * reads it. Empty/absent ⇒ a manually-created provider.
   */
  template?: string
  /**
   * Which upstream this connection speaks to — `anthropic`, `openai`, `moonshot`,
   * `doubao`, …, or `custom` for anything c3 has no directory entry for. Unlike
   * `template` (creation provenance, never read again) this is read continuously: it
   * selects the shipped model ids offered as suggestions for this provider, and stays
   * editable on its own so a hand-built endpoint can identify with a known vendor
   * without adopting its URLs. Absent ⇒ normalized to the vendor its `template` names,
   * else `custom`.
   *
   * Distinct from {@link VendorId}, which selects the agent CLI c3 launches.
   */
  vendor?: ProviderVendorId
  /**
   * Account-level API key shared by every protocol URL on this provider. Encrypted
   * at rest (`c3secretvN:` prefix); plaintext on the wire / in memory. Must be
   * non-empty for the provider to be usable.
   */
  apiKey: string
  /**
   * Per-protocol base URLs. A protocol with a non-empty URL is "connected"; an
   * agent whose vendor support list never hits a filled slot cannot launch through
   * this provider. A provider with zero usable URLs is valid but cannot launch any
   * agent.
   */
  urls: Partial<Record<ProtocolType, string>>
  /**
   * OpenAI-slot wire dialect (`'responses'` ⇒ direct, `'chat'` ⇒ via the c3
   * Responses→Chat relay). Only meaningful when `urls.openai` is set; defaults to
   * `'chat'` (the third-party-gateway default).
   */
  wireApi?: 'responses' | 'chat'
  /**
   * This provider's OWN model entries — additions to, and overrides of, the models
   * `vendor` ships. `effectiveProviderModels` merges the two into the suggestions the
   * agent form offers. NOT a runtime default and NOT an allowlist; an agent's own
   * `config.model` is always the selected model, listed here or not.
   */
  models?: ModelProviderModel[]
  /**
   * Operator pause flag. When `true`, the provider is marked "under maintenance":
   * agents referencing it fail loudly at launch with a clear error (rather than a
   * cryptic auth failure), and the console greys out the provider in pickers. A
   * paused provider keeps all its data and is resumable by setting this back to
   * `false`. Absent/`false` ⇒ active.
   */
  paused?: boolean
}

/** Resolved upstream for one agent against one provider. */
export interface ResolvedProviderUrl {
  baseUrl: string
  apiKey: string
  /** Which protocol slot supplied the URL. */
  protocol: ProtocolType
  /** Present only when the selected protocol is `openai`. */
  wireApi?: 'responses' | 'chat'
}

/**
 * Resolve the effective URL for a vendor from a provider: walk the vendor's
 * protocol list, take the first non-empty URL, pair it with the account key.
 * Returns `null` when no protocol slot is filled (caller falls back to system
 * login). Pure — no IO, no mutation.
 */
export function resolveProviderUrl(
  provider: ModelProvider,
  vendor: VendorId,
): ResolvedProviderUrl | null {
  const protocol = selectProtocol(vendor, provider.urls)
  if (!protocol) return null
  const baseUrl = provider.urls[protocol]?.trim() ?? ''
  if (!baseUrl) return null
  return {
    baseUrl,
    apiKey: provider.apiKey,
    protocol,
    ...(protocol === 'openai' && provider.wireApi !== undefined
      ? { wireApi: provider.wireApi }
      : {}),
  }
}

/**
 * Whether this provider can supply a base URL for `vendor` — i.e.
 * {@link selectProtocol} finds a filled slot. Used by the agent-form provider
 * picker to hide providers the vendor cannot reach.
 */
export function providerSupportsVendor(provider: ModelProvider, vendor: VendorId): boolean {
  return selectProtocol(vendor, provider.urls) !== null
}
