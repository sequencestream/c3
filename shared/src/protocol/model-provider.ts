/**
 * Named model-provider entities: the upstream connection (baseUrl / apiKey /
 * wireApi) lifted OUT of per-agent inline config so multiple agents can share one
 * provider, and key rotation / endpoint changes touch a single record.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 *
 * Relationship to agents: an agent carries an optional `providerId`; when set, the
 * runtime resolves the provider's connection for that agent's vendor instead of
 * reading the agent's inline `config.baseUrl`/`config.apiKey`. An empty `providerId`
 * keeps the legacy inline path (or the vendor CLI's own system login).
 *
 * Key layering: a provider has one account-level `apiKey` (the default for every
 * vendor connection) plus an optional per-vendor `apiKey` override inside each
 * `ProviderConnection`. The effective key for a vendor is `effectiveApiKey(
 * connection.apiKey, provider.apiKey)` — a blank override falls back to the account
 * key; at least one must be non-empty for the connection to be usable.
 *
 * Zero-runtime wire module: no zod, no vendor SDK. The runtime schema lives
 * server-side in `kernel/agent-config/model-provider-schema.ts`.
 */

import type { VendorId } from './vendor.js'

/**
 * One vendor's connection inside a {@link ModelProvider}. A provider may declare
 * connections for a subset of vendors; an agent whose vendor has no entry here
 * falls back to the legacy inline config (or system login).
 */
export interface ProviderConnection {
  /** The upstream base URL for this vendor. Empty ⇒ no override (the provider's
   *  account-level key alone is not enough — a base URL is required to point the
   *  agent at a non-default upstream). */
  baseUrl: string
  /**
   * Per-vendor API key override. When non-empty it takes priority over the
   * provider's account-level {@link ModelProvider.apiKey}; when empty the account
   * key is used. Encrypted at rest with the same scheme as agent apiKeys
   * (`c3secretvN:` prefix); plaintext on the wire / in memory.
   */
  apiKey?: string
  /**
   * Codex-only: which wire protocol the upstream speaks (`'responses'` ⇒ direct,
   * `'chat'` ⇒ via the c3 Responses→Chat relay). Irrelevant for non-codex vendors;
   * omitted on their connections. Defaults to `'chat'` when a codex connection is
   * created without it (the relay default for third-party providers).
   */
  wireApi?: 'responses' | 'chat'
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
 * reference via `providerId`. Lifting the connection triple out of per-agent config
 * means a key rotation or endpoint migration edits one row instead of N agents.
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
   * Account-level API key — the default key for every vendor connection that does
   * not declare its own override. Encrypted at rest (`c3secretvN:` prefix);
   * plaintext on the wire / in memory. May be empty when every connection carries
   * its own key, but at least one key (account or per-vendor) must be non-empty for
   * the provider to be usable.
   */
  apiKey: string
  /**
   * Per-vendor connection map. Only vendors with a non-empty `baseUrl` entry are
   * "connected"; an agent whose vendor is absent falls back to inline/system. A
   * provider with zero usable connections is valid but cannot launch any agent.
   */
  connections: Partial<Record<VendorId, ProviderConnection>>
  /**
   * Optional model catalog — pre-fill suggestions for new agents bound to this
   * provider. NOT a runtime default; an agent's own `config.model` always wins.
   * Absent/empty ⇒ no pre-fill (the agent form offers free-text model entry).
   */
  models?: ModelProviderModel[]
  /**
   * Set on a provider that the MIGRATION synthesized from legacy inline agent
   * configs, rather than one a user created by hand. It marks the record as
   * reversible: `revertProviderMigration` deletes exactly these (and only while no
   * agent still references them), returning the agents to their inline triple —
   * which is still there, because migration never erases it. A user edit of a
   * synthesized provider is expected to clear the flag (it is a hand-maintained
   * record from then on).
   */
  synthesized?: boolean
  /**
   * Operator pause flag. When `true`, the provider is marked "under maintenance":
   * agents referencing it fail loudly at launch with a clear error (rather than a
   * cryptic auth failure), and the console greys out the provider in pickers. A
   * paused provider keeps all its data and is resumable by setting this back to
   * `false`. Absent/`false` ⇒ active.
   */
  paused?: boolean
}

/**
 * One group of agents that share an identical legacy inline connection tuple
 * `(vendor, baseUrl, apiKey, wireApi)`, mapped to the provider they collapse onto.
 * Part of the migration REPORT the console renders — computed server-side, never
 * sent upward by a client.
 */
export interface ProviderMigrationGroup {
  /** The provider the agents would point at — an existing one, or a to-be-created synthesized one. */
  providerId: string
  /** True ⇒ `providerId` names an existing provider whose connection matches this tuple exactly. */
  reusesExisting: boolean
  /** The name the synthesized provider would carry (the existing one's name when reused). */
  displayName: string
  vendor: VendorId
  baseUrl: string
  /** The tuple's key, so the console can show a masked hint next to the group. */
  apiKey: string
  /** Codex-only wire protocol carried over from the agents' inline config. */
  wireApi?: 'responses' | 'chat'
  /** The agents that would be re-pointed, in settings order. */
  agentIds: string[]
}

/**
 * The migration report: what is still on a legacy inline triple, and what leftover
 * inline fields could be cleaned up. An empty `groups` with an empty
 * `clearableAgentIds` means the registry is fully migrated.
 */
export interface ProviderMigrationPlan {
  /** Pending groups: agents still on an inline triple, grouped by identical tuple. */
  groups: ProviderMigrationGroup[]
  /**
   * Agents already pointed at a provider that ALSO still carry a non-empty inline
   * `baseUrl` — the leftovers the one-way cleanup step would erase.
   */
  clearableAgentIds: string[]
}

/**
 * Merge a per-vendor `apiKey` override with the provider's account-level key: a
 * BLANK override (empty or whitespace-only) does not count and falls back to the
 * account key, same as an override the user never touched. This matters because the
 * console's connection-key input is a plain `v-model` text field — clearing it
 * stores `""`, not `undefined` — so a plain `??` merge would keep that empty string
 * and silently send a keyless request instead of falling back. Exported so every
 * merge site (resolution, migration matching, the connectivity probe) shares one
 * rule instead of drifting.
 */
export function effectiveApiKey(override: string | undefined, accountKey: string): string {
  return override?.trim() || accountKey
}

/**
 * Resolve the effective connection for a vendor from a provider: the vendor's
 * `ProviderConnection` if present, otherwise `null` (caller falls back to inline
 * config / system login). The returned connection's `apiKey` is already merged with
 * the provider's account-level key via {@link effectiveApiKey}.
 *
 * Pure function — no IO, no mutation. Exported so both the server runtime and web
 * console can compute "what would this agent actually connect to" without duplicating
 * the layering rule.
 */
export function resolveProviderConnection(
  provider: ModelProvider,
  vendor: VendorId,
): (ProviderConnection & { apiKey: string }) | null {
  const conn = provider.connections[vendor]
  if (!conn || !conn.baseUrl) return null
  return {
    baseUrl: conn.baseUrl,
    apiKey: effectiveApiKey(conn.apiKey, provider.apiKey),
    ...(conn.wireApi !== undefined ? { wireApi: conn.wireApi } : {}),
  }
}

/**
 * Whether a provider has at least one usable vendor connection (non-empty baseUrl
 * and a resolvable key — either per-vendor override or the account-level key). A
 * provider that returns `false` cannot launch any agent; the console marks it
 * "incomplete" and offers to fill in the missing fields.
 */
export function hasUsableConnection(provider: ModelProvider): boolean {
  for (const vendor of Object.keys(provider.connections) as VendorId[]) {
    const conn = provider.connections[vendor]
    if (conn && conn.baseUrl && effectiveApiKey(conn.apiKey, provider.apiKey)) return true
  }
  return false
}
