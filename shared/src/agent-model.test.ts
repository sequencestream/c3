import { describe, it, expect } from 'vitest'
import type { AgentConfig } from './protocol.js'
import { SYSTEM_AGENT_ID } from './protocol.js'
import { normalizeAgentRef, resolveDefaultAgentId } from './agent-model.js'

describe('resolveDefaultAgentId — fall through to next enabled (AC-R2/AC-R10, 2026-06-15-001)', () => {
  /** A minimal claude agent in `order_seq` array position; `enabled` defaults true. */
  function agent(id: string, enabled?: boolean): AgentConfig {
    return {
      id,
      vendor: 'claude',
      configMode: 'system',
      displayName: id,
      ...(enabled === undefined ? {} : { enabled }),
      config: { baseUrl: '', apiKey: '', model: '' },
    }
  }

  it('keeps the current default when it exists and is enabled', () => {
    const agents = [agent('a'), agent('b'), agent('c')]
    expect(resolveDefaultAgentId(agents, 'b')).toBe('b')
  })

  it('falls through to the NEXT enabled agent after a disabled default', () => {
    const agents = [agent('a'), agent('b', false), agent('c')]
    expect(resolveDefaultAgentId(agents, 'b')).toBe('c')
  })

  it('skips further disabled agents when scanning forward', () => {
    const agents = [agent('a'), agent('b', false), agent('c', false), agent('d')]
    expect(resolveDefaultAgentId(agents, 'b')).toBe('d')
  })

  it('wraps to the first enabled agent when nothing enabled follows the default', () => {
    const agents = [agent('a'), agent('b'), agent('c', false)]
    expect(resolveDefaultAgentId(agents, 'c')).toBe('a')
  })

  it('falls to the first enabled agent when the current default was removed', () => {
    const agents = [agent('a', false), agent('b'), agent('c')]
    expect(resolveDefaultAgentId(agents, 'gone')).toBe('b')
  })

  it('returns SYSTEM_AGENT_ID when every agent is disabled', () => {
    const agents = [agent('a', false), agent('b', false)]
    expect(resolveDefaultAgentId(agents, 'a')).toBe(SYSTEM_AGENT_ID)
  })

  it('treats a missing `enabled` flag as enabled (back-compat)', () => {
    const agents = [agent('a'), agent('b')]
    expect(resolveDefaultAgentId(agents, 'a')).toBe('a')
  })

  it('keeps a group ref default while the group still has an enabled member (ADR-0029)', () => {
    const grouped = { ...agent('a'), group: 'fast' }
    const agents = [grouped, agent('b')]
    expect(resolveDefaultAgentId(agents, '_c3_claude_fast')).toBe('_c3_claude_fast')
  })

  it('falls a group ref default through to the first enabled agent when the group emptied', () => {
    const agents = [agent('a'), agent('b')] // no member carries `fast`
    expect(resolveDefaultAgentId(agents, '_c3_claude_fast')).toBe('a')
  })
})

describe('normalizeAgentRef — delete restores following, disable rewrites', () => {
  /** A claude agent in `order_seq` array position; `enabled` defaults true. */
  function agent(id: string, extra: Partial<AgentConfig> = {}): AgentConfig {
    return {
      id,
      vendor: 'claude',
      configMode: 'system',
      displayName: id,
      config: { baseUrl: '', apiKey: '', model: '' },
      ...extra,
    } as AgentConfig
  }
  const registry = [agent('a'), agent('b'), agent('c')]

  it('keeps the blank "follow the default" sentinel blank', () => {
    expect(normalizeAgentRef(registry, '')).toBe('')
    expect(normalizeAgentRef(registry, '   ')).toBe('')
    expect(normalizeAgentRef(registry, undefined)).toBe('')
    expect(normalizeAgentRef(registry, 42)).toBe('')
  })

  it('keeps an existing, enabled reference (trimming it)', () => {
    expect(normalizeAgentRef(registry, 'b')).toBe('b')
    expect(normalizeAgentRef(registry, ' b ')).toBe('b')
  })

  it('rewrites a DISABLED reference to the next enabled agent', () => {
    const agents = [agent('a'), agent('b', { enabled: false }), agent('c')]
    expect(normalizeAgentRef(agents, 'b')).toBe('c')
  })

  it('rewrites a disabled reference with no successor to the first enabled agent', () => {
    const agents = [agent('a'), agent('b'), agent('c', { enabled: false })]
    expect(normalizeAgentRef(agents, 'c')).toBe('a')
  })

  it('rewrites to the system fallback when every agent is disabled', () => {
    const agents = [agent('a', { enabled: false }), agent('b', { enabled: false })]
    expect(normalizeAgentRef(agents, 'a')).toBe(SYSTEM_AGENT_ID)
  })

  it('CLEARS (null) a reference whose concrete agent was deleted', () => {
    expect(normalizeAgentRef(registry, 'gone')).toBeNull()
  })

  it('keeps a group reference that still has an enabled member', () => {
    const agents = [agent('a'), agent('b', { group: 'fast' })]
    expect(normalizeAgentRef(agents, '_c3_claude_fast')).toBe('_c3_claude_fast')
  })

  it('treats an EMPTIED group as a group, not as a deleted id', () => {
    // Its last member left: rewritten to the first enabled agent — never cleared,
    // which is what tells "the group is empty" apart from "the agent is gone".
    const agents = [agent('a'), agent('b')]
    expect(normalizeAgentRef(agents, '_c3_claude_fast')).toBe('a')
    const allOff = [agent('a', { enabled: false })]
    expect(normalizeAgentRef(allOff, '_c3_claude_fast')).toBe(SYSTEM_AGENT_ID)
  })

  it('is idempotent — re-normalizing a normalized value changes nothing', () => {
    const agents = [agent('a'), agent('b', { enabled: false }), agent('c')]
    for (const input of ['', 'a', 'b', '_c3_claude_fast', 'gone']) {
      const once = normalizeAgentRef(agents, input)
      expect(normalizeAgentRef(agents, once ?? '')).toBe(once ?? '')
    }
  })
})
