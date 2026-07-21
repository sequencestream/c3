import { describe, it, expect } from 'vitest'
import type { AgentConfig } from './protocol.js'
import { SYSTEM_AGENT_ID } from './protocol.js'
import { resolveDefaultAgentId } from './agent-model.js'

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
