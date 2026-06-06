/**
 * Pure agent-registry shape + normalizers — the leaf the settings store sits on
 * (server refactor 3/3, ADR-0009). No `loadSettings`/IO dependency, so both the
 * config store (which calls these inside `normalize`) and the agent readers can
 * import it without a cycle: store → here, readers → store + here, here → nobody.
 */
import type { AgentConfig, ClaudeAgentConfig, SystemSettings, VendorId } from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'

/** Hard cap for an agent's `icon` string. Generous enough for family/ZWJ emoji
 *  sequences (can be 7-11 code units), short enough to deter abuse. */
export const AGENT_ICON_MAX_CHARS = 16

/**
 * Force an agent icon into shape: a trimmed string truncated to
 * {@link AGENT_ICON_MAX_CHARS}; anything missing / non-string / empty-after-trim
 * ⇒ `''` (no custom icon). Back-compat: old configs without `icon` are treated
 * the same as empty.
 */
export function normalizeIcon(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  return trimmed.length > AGENT_ICON_MAX_CHARS ? trimmed.slice(0, AGENT_ICON_MAX_CHARS) : trimmed
}

/**
 * A vendor's *default* config sub-object — the system agent's config and the
 * baseline for a fresh agent of that vendor. Claude's default is all-empty (no
 * overrides ⇒ the SDK's own resolution / the user's existing `claude` login).
 * Only `claude` has a config shape today (ADR-0011 reference adapter); a new
 * vendor adds its branch here returning that vendor's default config.
 */
export function defaultConfigFor(vendor: VendorId): ClaudeAgentConfig {
  void vendor // single-vendor today; the switch grows with each new adapter
  return { baseUrl: '', apiKey: '', model: '' }
}

/**
 * The synthesized fallback agent (2026-06-06-007): a `claude` agent in
 * `configMode: 'system'` (first-party Claude, no overrides — the user's existing
 * `claude` login). Used as the default seed on first boot and as the ultimate
 * safety net when settings are empty/corrupt, so a session is never locked out.
 * It is NOT undeletable anymore — `configMode: 'system'` is just a per-agent
 * option; this is only the synthesized instance. `enabled`/`icon` are honoured.
 */
export function systemAgent(enabled = true, icon = ''): AgentConfig {
  return {
    id: SYSTEM_AGENT_ID,
    vendor: 'claude',
    configMode: 'system',
    displayName: 'System',
    enabled,
    icon,
    config: defaultConfigFor('claude'),
  }
}

export function defaultSettings(): SystemSettings {
  return { agents: [systemAgent()], defaultAgentId: SYSTEM_AGENT_ID }
}

/**
 * Normalise the degradation chain: keep only ids that reference an *enabled*
 * agent in `agents`, preserve order, and strip duplicates. Disabled agents are
 * dropped (they must not appear in the fallback chain). If the result is empty
 * (nothing was valid/enabled, or the input was absent/empty) return undefined ⇒
 * no degradation (current behaviour, single-agent fallback).
 */
export function normalizeDegradationChain(
  raw: unknown,
  agents: AgentConfig[],
): string[] | undefined {
  const valid = new Set(agents.filter((a) => a.enabled !== false).map((a) => a.id))
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of raw) {
    if (typeof id !== 'string' || !id) continue
    if (!valid.has(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result.length > 0 ? result : undefined
}
