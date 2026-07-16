import { describe, it, expect } from 'vitest'
import type { AgentConfig } from '@ccc/shared/protocol'
import { listGroupAgents, groupAgentsOfVendor, agentRefDisplayName } from './group-agents'

function claude(id: string, order: number, group?: string, enabled = true): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: 'custom',
    displayName: id.toUpperCase(),
    order_seq: order,
    enabled,
    ...(group !== undefined ? { group } : {}),
    config: { baseUrl: `https://${id}/anthropic`, apiKey: 'k', model: 'm' },
  }
}
function codex(id: string, order: number, group?: string): AgentConfig {
  return {
    id,
    vendor: 'codex',
    configMode: 'custom',
    displayName: id.toUpperCase(),
    order_seq: order,
    enabled: true,
    ...(group !== undefined ? { group } : {}),
    config: { baseUrl: `https://${id}`, apiKey: 'k', model: 'm', wireApi: 'chat' },
  }
}

describe('listGroupAgents (ADR-0029)', () => {
  it('one virtual agent per distinct (vendor, group); different vendors may share a name', () => {
    const agents = [
      claude('a2', 1, 'fast'),
      claude('a1', 0, 'fast'),
      claude('a3', 2, 'fast', false), // disabled ⇒ ignored
      codex('cx', 3, 'fast'), // same name, different vendor ⇒ its OWN (codex, fast) group
      codex('cy', 4, 'cheap'),
    ]
    const groups = listGroupAgents(agents)
    // (claude, fast), (codex, fast) and (codex, cheap) are three distinct groups.
    expect(groups).toEqual([
      { id: '_c3_claude_fast', group: 'fast', vendor: 'claude' },
      { id: '_c3_codex_fast', group: 'fast', vendor: 'codex' },
      { id: '_c3_codex_cheap', group: 'cheap', vendor: 'codex' },
    ])
  })

  it('ignores ungrouped and disabled agents', () => {
    expect(listGroupAgents([claude('a', 0), claude('b', 1, '')])).toEqual([])
    expect(listGroupAgents([claude('a', 0, 'g', false)])).toEqual([])
  })

  it('groupAgentsOfVendor filters by the locked vendor', () => {
    const agents = [claude('a1', 0, 'fast'), codex('cy', 1, 'cheap')]
    expect(groupAgentsOfVendor(agents, 'claude').map((g) => g.id)).toEqual(['_c3_claude_fast'])
    expect(groupAgentsOfVendor(agents, 'codex').map((g) => g.id)).toEqual(['_c3_codex_cheap'])
  })
})

describe('agentRefDisplayName', () => {
  const agents = [claude('a1', 0, 'fast')]
  it('returns the prefixed ref for a group ref', () => {
    expect(agentRefDisplayName(agents, '_c3_claude_fast')).toBe('_c3_claude_fast')
  })
  it('returns the real agent displayName for a real id', () => {
    expect(agentRefDisplayName(agents, 'a1')).toBe('A1')
  })
  it('returns null for unknown/empty', () => {
    expect(agentRefDisplayName(agents, 'nope')).toBeNull()
    expect(agentRefDisplayName(agents, null)).toBeNull()
  })
})
