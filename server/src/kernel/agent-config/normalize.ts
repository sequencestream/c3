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
    order_seq: 0,
    config: defaultConfigFor('claude'),
  }
}

/**
 * One parsed agent paired with the `order_seq` it carried on disk (a finite
 * number) or `undefined` when the persisted record had none — the input to
 * {@link canonicalizeAgentOrder}. The raw presence is tracked separately from the
 * parsed agent because the zod layer may default a missing value, which would
 * erase the "this one had no explicit position ⇒ append at the tail" signal.
 */
export interface AgentOrderEntry {
  agent: AgentConfig
  rawOrder: number | undefined
}

/**
 * Regularize the agent registry into the canonical, user-controlled order and
 * stamp a dense `0..n` `order_seq` on each (the single sort key every implicit
 * "list of agents" consumer reads — see {@link AgentConfigBase.order_seq}).
 *
 * Stable sort, three tiers:
 *  1. the system agent ({@link SYSTEM_AGENT_ID}) is pinned to the front (kept
 *     stable on top even if its persisted `order_seq` is larger);
 *  2. then agents with an explicit `order_seq`, ascending;
 *  3. then agents missing one, in their current array order (insertion order),
 *     appended at the tail.
 * Ties (and the missing-order group) break by original index ⇒ stable. The final
 * `order_seq` is reassigned sequentially, which also dedupes any duplicate
 * positions a hand-edited config might carry.
 */
export function canonicalizeAgentOrder(entries: AgentOrderEntry[]): AgentConfig[] {
  const ranked = entries.map((e, i) => ({ ...e, i }))
  ranked.sort((x, y) => {
    const sx = x.agent.id === SYSTEM_AGENT_ID ? 0 : 1
    const sy = y.agent.id === SYSTEM_AGENT_ID ? 0 : 1
    if (sx !== sy) return sx - sy
    const ox = x.rawOrder ?? Infinity
    const oy = y.rawOrder ?? Infinity
    if (ox !== oy) return ox - oy
    return x.i - y.i
  })
  return ranked.map(({ agent }, idx) => {
    // The parsed agent is a fresh object from zod (or the synthesized fallback);
    // mutate in place to avoid spreading the discriminated union (which would
    // widen `vendor`/`config` and break the arm correlation).
    agent.order_seq = idx
    return agent
  })
}

export function defaultSettings(): SystemSettings {
  return {
    agents: [systemAgent()],
    defaultAgentId: SYSTEM_AGENT_ID,
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: '',
    automationAgentId: '',
  }
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
