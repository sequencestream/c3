/**
 * The dual-track migration from per-agent INLINE connection triples to named
 * {@link ModelProvider} records.
 *
 * Dual-track means: nothing is rewritten behind the user's back. A pre-registry
 * agent (`configMode: 'custom'`, a real `config.baseUrl`, no `providerId`) keeps
 * running through its inline triple for as long as the user leaves it alone — see
 * `provider-resolve.ts`. What this module adds is a REPORT of what the registry
 * would look like ({@link planProviderMigration}) plus the three writes that act on
 * it, each explicit and each reversible until the last one:
 *
 *  - {@link applyProviderMigration}  — create/reuse providers, point agents at them.
 *    The inline triple is left untouched, which is what makes the step reversible.
 *  - {@link revertProviderMigration} — undo the above: clear `providerId`, delete
 *    the synthesized providers nothing references anymore. The agents fall back to
 *    the inline triple that was never removed.
 *  - {@link clearInlineConnections}  — the FINAL, one-way cleanup: erase the
 *    now-dead inline `baseUrl`/`apiKey`. Only offered after apply, never automatic.
 *
 * De-duplication: agents sharing an identical `(vendor, baseUrl, apiKey, wireApi)`
 * tuple collapse onto ONE provider — the whole point of the abstraction. An
 * existing hand-made provider whose URL matches that tuple is reused instead of
 * minting a near-duplicate.
 *
 * Pure: every function takes what it reads and returns a new object. No IO, no
 * mutation of the input.
 */
import { createHash } from 'node:crypto'
import type {
  AgentConfig,
  ModelProvider,
  ProtocolType,
  ProviderMigrationGroup,
  ProviderMigrationPlan,
  SystemSettings,
  VendorId,
} from '@ccc/shared/protocol'
import { VENDOR_PROTOCOL_TYPES, hasProviderConfig } from '@ccc/shared/protocol'

/** The tuple identity two agents must share to collapse onto one provider. */
function tupleKey(vendor: VendorId, baseUrl: string, apiKey: string, wireApi?: string): string {
  return [vendor, baseUrl, apiKey, wireApi ?? ''].join(' ')
}

/**
 * A stable id for a synthesized provider — derived from the tuple, so re-planning
 * the same settings yields the same id and an apply is idempotent. Prefixed to keep
 * it visibly distinct from the timestamp-minted ids of hand-created providers.
 */
function synthesizedId(key: string): string {
  return `mp-syn-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`
}

/**
 * A readable name for a synthesized provider, taken from the base URL's host: the
 * registrable label (`api.deepseek.com` becomes `Deepseek`), title-cased. Falls
 * back to the raw host, then to the vendor, when the URL cannot be parsed (a
 * hand-edited config may hold anything).
 */
function nameFromBaseUrl(baseUrl: string, vendor: VendorId): string {
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    host = baseUrl.replace(/^[a-z]+:\/+/i, '').split('/')[0] ?? ''
  }
  if (!host) return vendor
  const parts = host.split('.').filter(Boolean)
  const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
  if (!label || /^\d+$/.test(label)) return host
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** Ensure a display name is unique within `taken`, appending a numeric suffix. */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

/** The inline tuple an agent still connects through, or null when it has none. */
function inlineTuple(
  agent: AgentConfig,
): { vendor: VendorId; baseUrl: string; apiKey: string; wireApi?: 'responses' | 'chat' } | null {
  if (!hasProviderConfig(agent)) return null
  if (agent.configMode !== 'custom') return null
  if (agent.providerId) return null
  const { baseUrl, apiKey } = agent.config
  if (!baseUrl) return null
  return {
    vendor: agent.vendor,
    baseUrl,
    apiKey,
    ...(agent.vendor === 'codex' ? { wireApi: agent.config.wireApi } : {}),
  }
}

/** Protocol slot a vendor's inline URL lands in when synthesized into a provider. */
function protocolForVendor(vendor: VendorId): ProtocolType {
  return VENDOR_PROTOCOL_TYPES[vendor][0]
}

/**
 * A migrated agent that still carries leftover inline connection fields — the
 * plan's `clearableAgentIds` and {@link clearInlineConnections} share this
 * predicate so the console's "what would clear" list matches what clear actually
 * erases (baseUrl alone, apiKey alone, or both).
 */
function hasClearableInlineResidue(agent: AgentConfig): boolean {
  if (!agent.providerId || !hasProviderConfig(agent)) return false
  return !!(agent.config.baseUrl || agent.config.apiKey)
}

/**
 * An existing provider whose URL for `vendor` is byte-identical to the tuple —
 * the reuse target that stops the migration from minting a duplicate of a
 * provider the user already made by hand. A `paused` provider is excluded: an
 * agent that was running fine on its inline triple must not be silently pointed
 * at a connection the operator has taken offline — migration would then be the
 * thing that breaks its next launch instead of leaving it alone.
 */
function findMatchingProvider(
  providers: readonly ModelProvider[],
  vendor: VendorId,
  baseUrl: string,
  apiKey: string,
  wireApi?: string,
): ModelProvider | undefined {
  const protocol = protocolForVendor(vendor)
  return providers.find((p) => {
    if (p.paused) return false
    if (p.urls[protocol] !== baseUrl) return false
    if (p.apiKey !== apiKey) return false
    if (protocol === 'openai' && wireApi !== undefined && (p.wireApi ?? 'chat') !== wireApi) {
      return false
    }
    return true
  })
}

/**
 * Compute the migration report for a settings snapshot. Never mutates and never
 * writes — the console shows this, and only an explicit user action calls
 * {@link applyProviderMigration}.
 */
export function planProviderMigration(
  agents: readonly AgentConfig[],
  providers: readonly ModelProvider[],
): ProviderMigrationPlan {
  const byKey = new Map<string, ProviderMigrationGroup>()
  const takenNames = new Set(providers.map((p) => p.displayName))
  const clearableAgentIds: string[] = []

  for (const agent of agents) {
    if (hasClearableInlineResidue(agent)) {
      clearableAgentIds.push(agent.id)
    }
    const tuple = inlineTuple(agent)
    if (!tuple) continue
    const key = tupleKey(tuple.vendor, tuple.baseUrl, tuple.apiKey, tuple.wireApi)
    const existing = byKey.get(key)
    if (existing) {
      existing.agentIds.push(agent.id)
      continue
    }
    const match = findMatchingProvider(
      providers,
      tuple.vendor,
      tuple.baseUrl,
      tuple.apiKey,
      tuple.wireApi,
    )
    byKey.set(key, {
      providerId: match ? match.id : synthesizedId(key),
      reusesExisting: !!match,
      displayName: match
        ? match.displayName
        : uniqueName(nameFromBaseUrl(tuple.baseUrl, tuple.vendor), takenNames),
      vendor: tuple.vendor,
      baseUrl: tuple.baseUrl,
      apiKey: tuple.apiKey,
      ...(tuple.wireApi !== undefined ? { wireApi: tuple.wireApi } : {}),
      agentIds: [agent.id],
    })
  }

  return { groups: [...byKey.values()], clearableAgentIds }
}

/**
 * Apply the migration: create the synthesized providers and point their agents at
 * them. `only` restricts the write to those provider ids (the console's per-group
 * migrate action); omitted means every pending group.
 *
 * Leaves each agent's inline triple in place — that is what
 * {@link revertProviderMigration} restores from. Returns a NEW settings object;
 * the input is untouched.
 */
export function applyProviderMigration(
  settings: SystemSettings,
  only?: readonly string[],
): { settings: SystemSettings; appliedProviderIds: string[] } {
  const providers = settings.modelProviders ?? []
  const plan = planProviderMigration(settings.agents, providers)
  const selected = plan.groups.filter((g) => !only || only.includes(g.providerId))
  if (selected.length === 0) return { settings, appliedProviderIds: [] }

  const created: ModelProvider[] = selected
    .filter((g) => !g.reusesExisting)
    .map((g) => ({
      id: g.providerId,
      displayName: g.displayName,
      apiKey: g.apiKey,
      urls: { [protocolForVendor(g.vendor)]: g.baseUrl },
      ...(g.wireApi !== undefined ? { wireApi: g.wireApi } : {}),
      synthesized: true,
    }))

  const agentToProvider = new Map<string, string>()
  for (const g of selected) for (const id of g.agentIds) agentToProvider.set(id, g.providerId)

  const agents = settings.agents.map((a) => {
    const providerId = agentToProvider.get(a.id)
    return providerId ? ({ ...a, providerId } as AgentConfig) : a
  })

  return {
    settings: { ...settings, agents, modelProviders: [...providers, ...created] },
    appliedProviderIds: selected.map((g) => g.providerId),
  }
}

/**
 * Undo an apply: clear `providerId` on the agents pointing at the given SYNTHESIZED
 * providers and delete those providers once nothing references them. Agents return
 * to the inline triple the apply never touched, so the revert is lossless — unless
 * {@link clearInlineConnections} has already run, which is why that step is separate
 * and explicitly labelled one-way.
 *
 * `only` restricts the revert to those provider ids; omitted means every synthesized
 * provider. Hand-created providers are never deleted here, and an agent pointing at
 * one is left alone.
 */
export function revertProviderMigration(
  settings: SystemSettings,
  only?: readonly string[],
): SystemSettings {
  const providers = settings.modelProviders ?? []
  const revertable = new Set(
    providers.filter((p) => p.synthesized && (!only || only.includes(p.id))).map((p) => p.id),
  )
  if (revertable.size === 0) return settings

  // Only unbind agents the migration itself pointed here — they still carry the
  // inline triple `applyProviderMigration` preserved (`hasClearableInlineResidue`).
  // An agent hand-bound to the same synthesized provider afterward (the console's
  // provider dropdown does not distinguish synthesized from hand-made) has no
  // inline fallback of its own; unbinding it would strand it on CLI login with no
  // way back, so it keeps its reference and the provider survives for it.
  const agents = settings.agents.map((a) => {
    if (!a.providerId || !revertable.has(a.providerId)) return a
    if (!hasClearableInlineResidue(a)) return a
    const { providerId: _dropped, ...rest } = a
    return rest as AgentConfig
  })

  const stillReferenced = new Set(agents.map((a) => a.providerId).filter(Boolean) as string[])
  const modelProviders = providers.filter((p) => !revertable.has(p.id) || stillReferenced.has(p.id))
  return { ...settings, agents, modelProviders }
}

/**
 * The one-way cleanup: erase the leftover inline `baseUrl`/`apiKey` on agents that
 * now resolve through a provider. `model` is kept — it is a standalone override, not
 * part of the connection. `only` restricts it to those agent ids; omitted means
 * every agent in the plan's `clearableAgentIds`.
 *
 * After this a {@link revertProviderMigration} can still clear the reference, but
 * the agent falls back to its vendor CLI login rather than the old upstream.
 * Callers must confirm with the user first.
 */
export function clearInlineConnections(
  settings: SystemSettings,
  only?: readonly string[],
): SystemSettings {
  let changed = false
  const agents = settings.agents.map((a) => {
    if (only && !only.includes(a.id)) return a
    if (!hasClearableInlineResidue(a)) return a
    changed = true
    return { ...a, config: { ...a.config, baseUrl: '', apiKey: '' } } as AgentConfig
  })
  // Same reference when nothing was erased — the migration handler keys off
  // `next !== current` to decide whether to persist and echo `changed: true`.
  return changed ? { ...settings, agents } : settings
}
