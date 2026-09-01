/**
 * One-shot load-time lift: leftover per-agent connection triples
 * (`config.baseUrl` / `config.apiKey`) become named {@link ModelProvider}
 * records, the agents point at them, and the leftover fields are erased.
 *
 * Agents do not carry a connection of their own. A disk record that still has
 * a leftover triple (stored `configMode: 'custom'`, a real `baseUrl`, no
 * `providerId`) is lifted here so the next launch uses a provider rather than
 * dropping to the vendor CLI's login. Callers collect the ids from the RAW
 * record — {@link deriveConfigMode} already treats leftover fields as inert,
 * so the stored mode is the only distinguisher between "unmigrated custom"
 * and "user switched back to CLI login with old text still sitting in the
 * form".
 *
 * Agents sharing an identical `(vendor, baseUrl, apiKey, wireApi)` tuple
 * collapse onto one provider; a matching hand-made provider is reused.
 *
 * Pure: takes what it reads and returns new arrays. No IO, no mutation of
 * the input.
 */
import { createHash } from 'node:crypto'
import type { AgentConfig, ModelProvider, ProtocolType, VendorId } from '@ccc/shared/protocol'
import { VENDOR_PROTOCOL_TYPES, deriveConfigMode, hasProviderConfig } from '@ccc/shared/protocol'

/** The tuple identity two agents must share to collapse onto one provider. */
function tupleKey(vendor: VendorId, baseUrl: string, apiKey: string, wireApi?: string): string {
  return [vendor, baseUrl, apiKey, wireApi ?? ''].join(' ')
}

/** Stable id derived from the tuple, so re-lifting the same leftover is idempotent. */
function liftedId(key: string): string {
  return `mp-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`
}

/**
 * A readable name from the base URL's host: the registrable label
 * (`api.deepseek.com` becomes `Deepseek`), title-cased. Falls back to the raw
 * host, then to the vendor, when the URL cannot be parsed.
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

function protocolForVendor(vendor: VendorId): ProtocolType {
  return VENDOR_PROTOCOL_TYPES[vendor][0]
}

function leftoverTuple(
  agent: AgentConfig,
): { vendor: VendorId; baseUrl: string; apiKey: string; wireApi?: 'responses' | 'chat' } | null {
  if (!hasProviderConfig(agent)) return null
  const { baseUrl, apiKey } = agent.config
  if (!baseUrl) return null
  return {
    vendor: agent.vendor,
    baseUrl,
    apiKey,
    ...(agent.vendor === 'codex' ? { wireApi: agent.config.wireApi } : {}),
  }
}

/**
 * An existing provider whose URL for `vendor` is byte-identical to the tuple —
 * reused instead of minting a near-duplicate. A `paused` provider is excluded:
 * an agent that was running on its leftover triple must not be pointed at a
 * connection the operator has taken offline.
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

function stripConnectionFields(agent: AgentConfig): AgentConfig {
  if (!hasProviderConfig(agent)) return { ...agent, configMode: deriveConfigMode(agent) }
  const next = {
    ...agent,
    config: { ...agent.config, baseUrl: '', apiKey: '' },
  } as AgentConfig
  return { ...next, configMode: deriveConfigMode(next) }
}

/**
 * Lift leftover connection triples on `liftIds` into named providers, then
 * erase leftover `baseUrl`/`apiKey` on every redirectable agent (`model` stays)
 * and re-derive `configMode`.
 */
export function liftInlineConnections(
  agents: readonly AgentConfig[],
  providers: readonly ModelProvider[],
  liftIds: ReadonlySet<string>,
): { agents: AgentConfig[]; modelProviders: ModelProvider[] } {
  type Group = {
    providerId: string
    reusesExisting: boolean
    displayName: string
    vendor: VendorId
    baseUrl: string
    apiKey: string
    wireApi?: 'responses' | 'chat'
    agentIds: string[]
  }
  const byKey = new Map<string, Group>()
  const takenNames = new Set(providers.map((p) => p.displayName))

  for (const agent of agents) {
    if (!liftIds.has(agent.id)) continue
    const tuple = leftoverTuple(agent)
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
      providerId: match ? match.id : liftedId(key),
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

  const created: ModelProvider[] = [...byKey.values()]
    .filter((g) => !g.reusesExisting)
    .map((g) => ({
      id: g.providerId,
      displayName: g.displayName,
      // A lifted record's upstream identity is unknown: it is reconstructed from a base
      // URL, and guessing a vendor from a host would hand it someone else's model list.
      vendor: 'custom' as const,
      apiKey: g.apiKey,
      urls: { [protocolForVendor(g.vendor)]: g.baseUrl },
      ...(g.wireApi !== undefined ? { wireApi: g.wireApi } : {}),
    }))

  const agentToProvider = new Map<string, string>()
  for (const g of byKey.values()) for (const id of g.agentIds) agentToProvider.set(id, g.providerId)

  const nextAgents = agents.map((a) => {
    const providerId = agentToProvider.get(a.id)
    const pointed = providerId ? ({ ...a, providerId } as AgentConfig) : a
    return stripConnectionFields(pointed)
  })

  return { agents: nextAgents, modelProviders: [...providers, ...created] }
}
