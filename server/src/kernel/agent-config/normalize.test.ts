import { describe, it, expect, vi } from 'vitest'
import type { AgentConfig } from '@ccc/shared/protocol'
import { guardReservedAgentIds } from './normalize.js'

/** A minimal agent factory for the namespace-guard tests. */
function agent(
  id: string,
  vendor: 'claude' | 'codex',
  group: string | undefined,
  enabled = true,
): AgentConfig {
  const base = {
    id,
    configMode: 'custom' as const,
    displayName: id,
    enabled,
    ...(group !== undefined ? { group } : {}),
  }
  return vendor === 'codex'
    ? {
        ...base,
        vendor,
        config: { baseUrl: 'https://x', apiKey: 'k', model: 'm', wireApi: 'chat' },
      }
    : { ...base, vendor, config: { baseUrl: 'https://x', apiKey: 'k', model: 'm' } }
}

describe('guardReservedAgentIds (ADR-0029)', () => {
  it('never mutates group fields — different vendors may reuse the same group name', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agents = [
      agent('a1', 'claude', 'fast'),
      agent('a2', 'claude', 'fast'),
      agent('cx', 'codex', 'fast'), // same name, different vendor ⇒ its own (codex, fast) group
    ]
    guardReservedAgentIds(agents)
    // Every agent keeps its `group` field verbatim; the codex "fast" is a distinct group.
    expect(agents.map((a) => a.group)).toEqual(['fast', 'fast', 'fast'])
    vi.restoreAllMocks()
  })

  it('warns when a real agent id intrudes on the reserved `_c3_` prefix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    guardReservedAgentIds([agent('_c3_claude_fast', 'claude', undefined)])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('leaves ungrouped agents untouched and does not warn on normal ids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agents = [agent('a1', 'claude', undefined), agent('a2', 'codex', '')]
    guardReservedAgentIds(agents)
    expect(agents[0].group).toBeUndefined()
    expect(agents[1].group).toBe('')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
