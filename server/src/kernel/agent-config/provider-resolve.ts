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
 *  4. The provider has a URL for this agent's vendor (first matching protocol in the
 *     vendor's support list) ⇒ use it with the account-level key.
 *  5. Nothing usable on the provider ⇒ inline / system, with a warning.
 *
 * Pure: no IO, no mutation, no throwing. Callers pass the provider registry in
 * (`loadSettings().modelProviders`), which keeps this unit-testable and lets the
 * console resolve a hypothetical edit before it is saved.
 */
import type { AgentConfig, ModelProvider, ProtocolType, VendorId } from '@ccc/shared/protocol'
import { hasProviderConfig, resolveModelOverride, resolveProviderUrl } from '@ccc/shared/protocol'

/** The upstream a resolution landed on. `null` connection ⇒ the vendor CLI's own login. */
export interface ResolvedConnection {
  baseUrl: string
  apiKey: string
  /** Codex-only; absent for other vendors (they have no wire-protocol choice). */
  wireApi?: 'responses' | 'chat'
  /** Which protocol slot supplied the URL when source is `provider`. */
  protocol?: ProtocolType
}

/**
 * Why a resolution is not the straightforward "the provider's own URL for this
 * vendor". Every arm is actionable in the console: each names the provider the
 * user has to fix.
 */
export type ConnectionWarning =
  | { kind: 'dangling-provider'; providerId: string }
  | { kind: 'provider-paused'; providerId: string }
  | { kind: 'provider-unusable'; providerId: string; vendor: VendorId }

/**
 * A resolved agent connection plus how it was reached.
 *
 *  - `provider` — the referenced provider supplied it via {@link resolveProviderUrl}.
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
 * Stamp the codex-only `wireApi` onto a provider URL: the provider's own value
 * wins, then the agent's inline choice, then the relay default (`chat`). Non-codex
 * vendors get no field at all.
 */
function withWireApi(
  agent: AgentConfig,
  conn: { baseUrl: string; apiKey: string; wireApi?: 'responses' | 'chat'; protocol: ProtocolType },
): ResolvedConnection {
  if (agent.vendor !== 'codex') {
    return { baseUrl: conn.baseUrl, apiKey: conn.apiKey, protocol: conn.protocol }
  }
  return {
    baseUrl: conn.baseUrl,
    apiKey: conn.apiKey,
    protocol: conn.protocol,
    wireApi: conn.wireApi ?? agent.config.wireApi ?? 'chat',
  }
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
  // protocol, so it never reaches a provider or an inline triple — even though
  // its vendor support list names openai/anthropic for a future binding path.
  if (!hasProviderConfig(agent)) return systemResolution()

  const providerId = agent.providerId?.trim() ?? ''
  if (!providerId) return inlineResolution(agent, [])

  const provider = providers.find((p) => p.id === providerId)
  if (!provider) return inlineResolution(agent, [{ kind: 'dangling-provider', providerId }])
  if (provider.paused) return systemResolution([{ kind: 'provider-paused', providerId }])

  const direct = resolveProviderUrl(provider, agent.vendor)
  if (direct) return { source: 'provider', connection: withWireApi(agent, direct), warnings: [] }

  return inlineResolution(agent, [{ kind: 'provider-unusable', providerId, vendor: agent.vendor }])
}

/**
 * Dedup connection warnings across launches. Returns the warnings that have not
 * yet been reported for this (agent, warning, fingerprint) episode; remembers
 * them in `reported`. Keys for this agent that are no longer active are dropped
 * so a later recurrence (after a fix, or after the config fingerprint moves)
 * re-alerts instead of staying silent for the process lifetime.
 *
 * `fingerprint` is whatever identifies the current resolution-relevant config
 * (provider id + urls/key/paused + leftover inline triple) — the caller builds it.
 */
export function takeFreshConnectionWarnings(
  reported: Set<string>,
  agentId: string,
  warnings: readonly ConnectionWarning[],
  fingerprint: string,
): ConnectionWarning[] {
  const prefix = `${agentId}:`
  const activeKeys = new Set<string>()
  const fresh: ConnectionWarning[] = []
  for (const w of warnings) {
    const key = `${agentId}:${w.kind}:${w.providerId}:${fingerprint}`
    activeKeys.add(key)
    if (reported.has(key)) continue
    reported.add(key)
    fresh.push(w)
  }
  for (const key of [...reported]) {
    if (key.startsWith(prefix) && !activeKeys.has(key)) reported.delete(key)
  }
  return fresh
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
