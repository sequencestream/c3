import { describe, expect, it } from 'vitest'
import type { AgentConfig, ModelProvider } from '@ccc/shared/protocol'
import { hasProviderConfig } from '@ccc/shared/protocol'
import { liftInlineConnections } from './lift-inline-connections.js'

function agent(over: Record<string, unknown>): AgentConfig {
  return {
    id: 'a',
    vendor: 'claude',
    configMode: 'custom',
    displayName: 'A',
    config: { baseUrl: '', apiKey: '', model: '' },
    enabled: true,
    ...over,
  } as AgentConfig
}

function leftover(id: string, baseUrl: string, apiKey: string): AgentConfig {
  return agent({ id, configMode: 'custom', config: { baseUrl, apiKey, model: 'm' } })
}

describe('liftInlineConnections', () => {
  it('creates one provider per identical leftover tuple and points the agents at it', () => {
    const a1 = leftover('a1', 'https://api.deepseek.com/anthropic', 'sk-1')
    const a2 = leftover('a2', 'https://api.deepseek.com/anthropic', 'sk-1')
    const { agents, modelProviders } = liftInlineConnections([a1, a2], [], new Set(['a1', 'a2']))
    expect(modelProviders).toHaveLength(1)
    expect(modelProviders[0]).toMatchObject({
      apiKey: 'sk-1',
      urls: { anthropic: 'https://api.deepseek.com/anthropic' },
    })
    expect(agents.map((a) => a.providerId)).toEqual([modelProviders[0].id, modelProviders[0].id])
    expect(agents.every((a) => a.configMode === 'custom')).toBe(true)
    expect(
      agents.every(
        (a) => hasProviderConfig(a) && a.config.baseUrl === '' && a.config.apiKey === '',
      ),
    ).toBe(true)
    expect(agents.every((a) => a.vendor === 'claude' && a.config.model === 'm')).toBe(true)
  })

  it('reuses an existing provider whose connection matches the tuple', () => {
    const existing: ModelProvider = {
      id: 'p1',
      displayName: 'DeepSeek',
      apiKey: 'sk-1',
      urls: { anthropic: 'https://api.deepseek.com/anthropic' },
    }
    const { agents, modelProviders } = liftInlineConnections(
      [leftover('a1', 'https://api.deepseek.com/anthropic', 'sk-1')],
      [existing],
      new Set(['a1']),
    )
    expect(modelProviders).toEqual([existing])
    expect(agents[0].providerId).toBe('p1')
  })

  it('does not reuse a paused provider', () => {
    const paused: ModelProvider = {
      id: 'p1',
      displayName: 'DeepSeek',
      apiKey: 'sk-1',
      urls: { anthropic: 'https://api.deepseek.com/anthropic' },
      paused: true,
    }
    const { agents, modelProviders } = liftInlineConnections(
      [leftover('a1', 'https://api.deepseek.com/anthropic', 'sk-1')],
      [paused],
      new Set(['a1']),
    )
    expect(modelProviders).toHaveLength(2)
    expect(agents[0].providerId).not.toBe('p1')
  })

  it('ignores agents not in liftIds and still strips leftover connection fields', () => {
    const keep = leftover('keep', 'https://old.example', 'k')
    const skip = leftover('skip', 'https://other.example', 'k2')
    const { agents, modelProviders } = liftInlineConnections([keep, skip], [], new Set(['keep']))
    expect(modelProviders).toHaveLength(1)
    expect(agents.find((a) => a.id === 'keep')?.providerId).toBe(modelProviders[0].id)
    expect(agents.find((a) => a.id === 'skip')?.providerId).toBeUndefined()
    expect(agents.find((a) => a.id === 'skip')?.configMode).toBe('system')
    expect(
      agents.every(
        (a) => hasProviderConfig(a) && a.config.baseUrl === '' && a.config.apiKey === '',
      ),
    ).toBe(true)
  })

  it('is a no-op when liftIds is empty besides stripping leftover fields', () => {
    const a = leftover('a1', 'https://old.example', 'k')
    const { agents, modelProviders } = liftInlineConnections([a], [], new Set())
    expect(modelProviders).toEqual([])
    expect(agents[0].providerId).toBeUndefined()
    expect(agents[0].configMode).toBe('system')
    expect(agents[0].config).toMatchObject({ baseUrl: '', apiKey: '', model: 'm' })
  })

  it('lifts a leftover triple even when configMode has already been derived to system', () => {
    const a = leftover('a1', 'https://old.example', 'k')
    a.configMode = 'system'
    const { agents, modelProviders } = liftInlineConnections([a], [], new Set(['a1']))
    expect(modelProviders).toHaveLength(1)
    expect(agents[0].providerId).toBe(modelProviders[0].id)
    expect(agents[0].configMode).toBe('custom')
  })

  it('carries codex wireApi onto the lifted provider', () => {
    const cx = agent({
      id: 'cx',
      vendor: 'codex',
      configMode: 'custom',
      config: {
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk',
        model: 'm',
        wireApi: 'responses',
      },
    })
    const { modelProviders } = liftInlineConnections([cx], [], new Set(['cx']))
    expect(modelProviders[0]).toMatchObject({
      urls: { openai: 'https://api.deepseek.com' },
      wireApi: 'responses',
    })
  })
})
