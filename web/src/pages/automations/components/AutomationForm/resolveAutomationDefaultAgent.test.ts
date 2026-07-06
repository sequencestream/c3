import { describe, it, expect } from 'vitest'
import type { AgentConfig } from '@ccc/shared/protocol'
import { resolveAutomationDefaultAgent } from './resolveAutomationDefaultAgent'

const claude = (id: string, enabled?: boolean): AgentConfig => ({
  id,
  vendor: 'claude',
  configMode: 'custom',
  displayName: id,
  ...(enabled === undefined ? {} : { enabled }),
  config: { baseUrl: '', apiKey: '', model: '' },
})
const codex = (id: string): AgentConfig => ({
  id,
  vendor: 'codex',
  configMode: 'custom',
  displayName: id,
  config: { wireApi: 'chat', baseUrl: '', apiKey: '', model: '' },
})

describe('resolveAutomationDefaultAgent — create-form seed follow-chain (AC-R25)', () => {
  const agents = [claude('a1'), codex('a2'), claude('a3')]

  it('resolves a non-empty automationAgentId to that agent (with its vendor)', () => {
    expect(resolveAutomationDefaultAgent(agents, 'a2', 'a1')).toMatchObject({
      id: 'a2',
      vendor: 'codex',
    })
  })

  it('follows defaultAgentId when automationAgentId is empty', () => {
    expect(resolveAutomationDefaultAgent(agents, '', 'a2')).toMatchObject({ id: 'a2' })
  })

  it('falls back to the first enabled agent when both ids are empty', () => {
    expect(resolveAutomationDefaultAgent(agents, '', '')).toMatchObject({ id: 'a1' })
  })

  it('falls back to the first enabled agent when the wanted id is unknown', () => {
    expect(resolveAutomationDefaultAgent(agents, 'gone', '')).toMatchObject({ id: 'a1' })
  })

  it('never seeds a disabled agent — skips it in the enabled pool', () => {
    const withDisabled = [claude('a1', false), codex('a2')]
    // wanted points at the disabled a1 ⇒ falls back to first enabled (a2).
    expect(resolveAutomationDefaultAgent(withDisabled, 'a1', '')).toMatchObject({ id: 'a2' })
  })

  it('returns undefined when no enabled agent exists (caller applies system fallback)', () => {
    expect(resolveAutomationDefaultAgent([claude('a1', false)], 'a1', '')).toBeUndefined()
    expect(resolveAutomationDefaultAgent([], '', '')).toBeUndefined()
  })
})
