/**
 * Where an agent's upstream connection actually comes from — the ONE place that
 * applies the provider-vs-inline layering, so the launch path, the console's
 * dry-run and any future health probe cannot drift apart.
 *
 * Resolution order for a non-cursor agent:
 *  1. `providerId` empty ⇒ the legacy INLINE triple on `agent.config` (dual-track:
 *     an unmigrated config keeps running untouched). An empty inline `baseUrl` in
 *     turn means "the vendor CLI's own login" (system).
 *  2. `providerId` names a provider that no longer exists ⇒ FAIL SOFT: fall back to
 *     the inline triple / system login and report a `dangling-provider` warning,
 *     rather than breaking the launch over a stale reference.
 *  3. The provider is PAUSED ⇒ no connection and a `provider-paused` warning; the
 *     launch path turns that into a loud {@link ModelProviderPausedError} instead of
 *     letting the run fail later with a cryptic auth error.
 *  4. The provider has a connection for this agent's vendor ⇒ use it (per-vendor
 *     `apiKey` overriding the account-level key).
 *  5. The provider has connections, but none for this vendor ⇒ DEGRADE to the first
 *     other usable connection and report it, rather than silently dropping to the
 *     CLI login the user did not ask for.
 *  6. Nothing usable on the provider ⇒ inline / system, with a warning.
 *
 * Pure: no IO, no mutation, no throwing. Callers pass the provider registry in
 * (`loadSettings().modelProviders`), which keeps this unit-testable and lets the
 * console resolve a hypothetical edit before it is saved.
 */
import type { AgentConfig, ModelProvider, VendorId } from '@ccc/shared/protocol'
import {
  VENDOR_IDS,
  hasProviderConfig,
  resolveModelOverride,
  resolveProviderConnection,
} from '@ccc/shared/protocol'

/** The upstream a resolution landed on. `null` connection ⇒ the vendor CLI's own login. */
export interface ResolvedConnection {
  baseUrl: string
  apiKey: string
  /** Codex-only; absent for other vendors (they have no wire-protocol choice). */
  wireApi?: 'responses' | 'chat'
}

/**
 * Why a resolution is not the straightforward "the provider's own connection for
 * this vendor". Every arm is actionable in the console: each names the provider the
 * user has to fix.
 */
export type ConnectionWarning =
  | { kind: 'dangling-provider'; providerId: string }
  | { kind: 'provider-paused'; providerId: string }
  | {
      kind: 'vendor-connection-missing'
      providerId: string
      vendor: VendorId
      borrowedFrom: VendorId
    }
  | { kind: 'provider-unusable'; providerId: string; vendor: VendorId }

/**
 * A resolved agent connection plus how it was reached.
 *
 *  - `provider` — the referenced provider supplied it (possibly a borrowed vendor
 *    connection, see {@link ConnectionWarning}).
 *  - `inline`   — the legacy per-agent triple on `agent.config`.
 *  - `system`   — no connection at all: the vendor CLI's own login runs the agent.
 */
export interface ConnectionResolution {
  source: 'provider' | 'inline' | 'system'
  connection: ResolvedConnection | null
  warnings: ConnectionWarning[]
}

/** The `'system'` outcome — the vendor CLI's own login, nothing to relay. */
function systemResolution(warnings: ConnectionWarning[] = []): ConnectionResolution {
  return { source: 'system', connection: null, warnings }
}

/**
 * The legacy inline triple — an agent from before the provider registry, still
 * connecting through its own `config`. Gated on `configMode === 'custom'`, NOT on
 * "baseUrl happens to be non-empty": switching an agent to system mode leaves the
 * old base URL sitting in the form, and reviving it here would silently re-point a
 * subscription agent at a third-party upstream the user thought they had turned off.
 * Without a base URL the agent runs on the CLI's own login either way.
 */
function inlineResolution(agent: AgentConfig, warnings: ConnectionWarning[]): ConnectionResolution {
  if (!hasProviderConfig(agent)) return systemResolution(warnings)
  if (agent.configMode !== 'custom') return systemResolution(warnings)
  const { baseUrl, apiKey } = agent.config
  if (!baseUrl) return systemResolution(warnings)
  return {
    source: 'inline',
    connection: {
      baseUrl,
      apiKey,
      ...(agent.vendor === 'codex' ? { wireApi: agent.config.wireApi } : {}),
    },
    warnings,
  }
}

/**
 * Stamp the codex-only `wireApi` onto a provider connection: the connection's own
 * value wins, then the agent's inline choice, then the relay default (`chat`, what
 * third-party providers speak). Non-codex vendors get no field at all.
 */
function withWireApi(
  agent: AgentConfig,
  conn: { baseUrl: string; apiKey: string; wireApi?: 'responses' | 'chat' },
): ResolvedConnection {
  if (agent.vendor !== 'codex') return { baseUrl: conn.baseUrl, apiKey: conn.apiKey }
  return {
    baseUrl: conn.baseUrl,
    apiKey: conn.apiKey,
    wireApi: conn.wireApi ?? agent.config.wireApi ?? 'chat',
  }
}

/**
 * The first connection on `provider` OTHER than `exclude`'s that carries a base URL
 * — the degradation target when the agent's own vendor has no entry. Scanned in the
 * fixed {@link VENDOR_IDS} order so the choice is stable across reloads (an object
 * key order would depend on how the record was last written).
 */
function borrowConnection(
  provider: ModelProvider,
  exclude: VendorId,
): { vendor: VendorId; conn: ResolvedConnection } | null {
  for (const vendor of VENDOR_IDS) {
    if (vendor === exclude) continue
    const conn = resolveProviderConnection(provider, vendor)
    if (conn)
      return {
        vendor,
        conn: {
          baseUrl: conn.baseUrl,
          apiKey: conn.apiKey,
          ...(conn.wireApi !== undefined ? { wireApi: conn.wireApi } : {}),
        },
      }
  }
  return null
}

/**
 * Resolve one agent's upstream connection against the provider registry. See the
 * file header for the full order; never throws — a paused provider surfaces as a
 * warning the launch path escalates.
 */
export function resolveAgentConnection(
  agent: AgentConfig,
  providers: readonly ModelProvider[],
): ConnectionResolution {
  // Cursor authenticates only through its own CLI login: no relay speaks its
  // protocol, so it never reaches a provider or an inline triple.
  if (!hasProviderConfig(agent)) return systemResolution()

  const providerId = agent.providerId?.trim() ?? ''
  if (!providerId) return inlineResolution(agent, [])

  const provider = providers.find((p) => p.id === providerId)
  if (!provider) return inlineResolution(agent, [{ kind: 'dangling-provider', providerId }])
  if (provider.paused) return systemResolution([{ kind: 'provider-paused', providerId }])

  const direct = resolveProviderConnection(provider, agent.vendor)
  if (direct) return { source: 'provider', connection: withWireApi(agent, direct), warnings: [] }

  const borrowed = borrowConnection(provider, agent.vendor)
  if (borrowed) {
    return {
      source: 'provider',
      connection: withWireApi(agent, borrowed.conn),
      warnings: [
        {
          kind: 'vendor-connection-missing',
          providerId,
          vendor: agent.vendor,
          borrowedFrom: borrowed.vendor,
        },
      ],
    }
  }

  return inlineResolution(agent, [{ kind: 'provider-unusable', providerId, vendor: agent.vendor }])
}

/**
 * The model capability fields (context window / max output tokens) that apply to
 * `model` for this agent, most specific first:
 *
 *  1. the agent's own `modelOverrides` entry for that model id,
 *  2. the referenced provider's catalog entry for it,
 *  3. the agent's inline codex config (the pre-provider location of these fields).
 *
 * Each field is resolved independently, so an agent override of only
 * `contextWindow` still inherits the catalog's `maxOutputTokens`. Returns an object
 * with the fields that resolved; absent fields mean "no catalog entry", which keeps
 * the codex driver's current default-metadata behaviour.
 */
export function resolveModelCaps(
  agent: AgentConfig,
  providers: readonly ModelProvider[],
  model: string,
): { contextWindow?: number; maxOutputTokens?: number } {
  const override = resolveModelOverride(agent, model)
  const providerId = agent.providerId?.trim() ?? ''
  const catalog = providerId
    ? providers.find((p) => p.id === providerId)?.models?.find((m) => m.id === model)
    : undefined
  const inline = agent.vendor === 'codex' ? agent.config : undefined
  const contextWindow = override?.contextWindow ?? catalog?.contextWindow ?? inline?.contextWindow
  const maxOutputTokens =
    override?.maxOutputTokens ?? catalog?.maxOutputTokens ?? inline?.maxOutputTokens
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}
