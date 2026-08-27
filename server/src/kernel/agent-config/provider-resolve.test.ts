import { describe, expect, it } from 'vitest'
import type { AgentConfig, ModelProvider } from '@ccc/shared/protocol'
import {
  resolveAgentConnection,
  resolveModelCaps,
  takeFreshConnectionWarnings,
} from './provider-resolve.js'

function claudeAgent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'a1',
    vendor: 'claude',
    configMode: 'system',
    displayName: 'A1',
    config: { baseUrl: '', apiKey: '', model: '' },
    enabled: true,
    ...over,
  } as AgentConfig
}

function codexAgent(over: Record<string, unknown> = {}): AgentConfig {
  return {
    id: 'cx',
    vendor: 'codex',
    configMode: 'system',
    displayName: 'CX',
    config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
    enabled: true,
    ...over,
  } as AgentConfig
}

const provider = (over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: 'p1',
  displayName: 'DeepSeek',
  apiKey: 'account-key',
  urls: { anthropic: 'https://api.deepseek.com/anthropic' },
  ...over,
})

describe('resolveAgentConnection — no provider reference', () => {
  it('cursor never resolves a connection (own CLI login only)', () => {
    const agent = {
      ...claudeAgent(),
      vendor: 'cursor',
      config: { apiKey: 'k', model: '' },
    } as AgentConfig
    const r = resolveAgentConnection(agent, [provider()])
    expect(r).toEqual({ source: 'system', connection: null, warnings: [] })
  })

  it('a legacy custom agent (no providerId) keeps using its inline triple', () => {
    const agent = claudeAgent({
      configMode: 'custom',
      config: { baseUrl: 'https://inline.example', apiKey: 'inline-key', model: 'm' },
    })
    const r = resolveAgentConnection(agent, [])
    expect(r.source).toBe('inline')
    expect(r.connection).toEqual({ baseUrl: 'https://inline.example', apiKey: 'inline-key' })
    expect(r.warnings).toEqual([])
  })

  it('a system-mode agent ignores leftover inline baseUrl/apiKey', () => {
    const agent = claudeAgent({
      configMode: 'system',
      config: { baseUrl: 'https://leftover.example', apiKey: 'stale', model: 'm' },
    })
    expect(resolveAgentConnection(agent, []).connection).toBeNull()
  })
})

describe('resolveAgentConnection — provider reference', () => {
  it('uses the first supported protocol URL and the account key', () => {
    const r = resolveAgentConnection(claudeAgent({ providerId: 'p1' }), [provider()])
    expect(r.source).toBe('provider')
    expect(r.connection).toEqual({
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'account-key',
      protocol: 'anthropic',
    })
  })

  it('codex picks the openai URL (first in its support list)', () => {
    const p = provider({
      urls: {
        openai: 'https://api.deepseek.com',
        anthropic: 'https://api.deepseek.com/anthropic',
      },
      wireApi: 'chat',
    })
    const r = resolveAgentConnection(codexAgent({ providerId: 'p1' }), [p])
    expect(r.connection).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      protocol: 'openai',
      wireApi: 'chat',
    })
  })

  it('a dangling providerId fails soft to the inline triple with a warning', () => {
    const agent = claudeAgent({
      providerId: 'gone',
      configMode: 'custom',
      config: { baseUrl: 'https://inline.example', apiKey: 'k', model: 'm' },
    })
    const r = resolveAgentConnection(agent, [provider()])
    expect(r.source).toBe('inline')
    expect(r.warnings).toEqual([{ kind: 'dangling-provider', providerId: 'gone' }])
  })

  it('a dangling providerId on an agent with no inline triple lands on system', () => {
    const r = resolveAgentConnection(claudeAgent({ providerId: 'gone' }), [])
    expect(r.source).toBe('system')
    expect(r.connection).toBeNull()
    expect(r.warnings[0].kind).toBe('dangling-provider')
  })

  it('a paused provider yields no connection and a paused warning', () => {
    const r = resolveAgentConnection(claudeAgent({ providerId: 'p1' }), [
      provider({ paused: true }),
    ])
    expect(r.connection).toBeNull()
    expect(r.warnings).toEqual([{ kind: 'provider-paused', providerId: 'p1' }])
  })

  it('does not borrow across protocols when the vendor slot is empty', () => {
    // A claude agent needs anthropic; an openai-only provider is unusable for it.
    const p = provider({ urls: { openai: 'https://codex.example' } })
    const r = resolveAgentConnection(claudeAgent({ providerId: 'p1' }), [p])
    expect(r.source).toBe('system')
    expect(r.warnings).toEqual([{ kind: 'provider-unusable', providerId: 'p1', vendor: 'claude' }])
  })

  it('a provider with no usable URL falls back to inline with a warning', () => {
    const agent = claudeAgent({
      providerId: 'p1',
      configMode: 'custom',
      config: { baseUrl: 'https://inline.example', apiKey: 'k', model: 'm' },
    })
    const r = resolveAgentConnection(agent, [provider({ urls: {} })])
    expect(r.source).toBe('inline')
    expect(r.warnings).toEqual([{ kind: 'provider-unusable', providerId: 'p1', vendor: 'claude' }])
  })
})

describe('resolveAgentConnection — codex wireApi', () => {
  it("takes the provider's wireApi first", () => {
    const p = provider({
      urls: { openai: 'https://c.example' },
      wireApi: 'responses',
    })
    const r = resolveAgentConnection(codexAgent({ providerId: 'p1' }), [p])
    expect(r.connection?.wireApi).toBe('responses')
  })

  it("falls back to the agent's own wireApi, then to chat", () => {
    const p = provider({ urls: { openai: 'https://c.example' } })
    const agent = codexAgent({
      providerId: 'p1',
      config: { baseUrl: '', apiKey: '', model: '', wireApi: 'responses' },
    })
    expect(resolveAgentConnection(agent, [p]).connection?.wireApi).toBe('responses')
    expect(resolveAgentConnection(codexAgent({ providerId: 'p1' }), [p]).connection?.wireApi).toBe(
      'chat',
    )
  })

  it('never stamps wireApi on a non-codex vendor', () => {
    const r = resolveAgentConnection(claudeAgent({ providerId: 'p1' }), [provider()])
    expect(r.connection).not.toHaveProperty('wireApi')
  })
})

describe('resolveModelCaps', () => {
  const p = provider({
    urls: { openai: 'https://c.example' },
    models: [{ id: 'm1', contextWindow: 100, maxOutputTokens: 200 }],
  })

  it('prefers the agent override, then the provider catalog, then the inline config', () => {
    const agent = codexAgent({
      providerId: 'p1',
      modelOverrides: [{ model: 'm1', contextWindow: 999 }],
      config: {
        baseUrl: '',
        apiKey: '',
        model: 'm1',
        wireApi: 'chat',
        contextWindow: 1,
        maxOutputTokens: 2,
      },
    })
    expect(resolveModelCaps(agent, [p], 'm1')).toEqual({ contextWindow: 999, maxOutputTokens: 200 })
  })

  it('falls back to the inline codex config for a model absent from every catalog', () => {
    const agent = codexAgent({
      providerId: 'p1',
      config: { baseUrl: '', apiKey: '', model: 'other', wireApi: 'chat', contextWindow: 7 },
    })
    expect(resolveModelCaps(agent, [p], 'other')).toEqual({ contextWindow: 7 })
  })

  it('yields nothing when no source carries capabilities', () => {
    expect(resolveModelCaps(claudeAgent({ providerId: 'p1' }), [provider()], 'm')).toEqual({})
  })
})

describe('takeFreshConnectionWarnings', () => {
  const dangling = { kind: 'dangling-provider' as const, providerId: 'gone' }

  it('reports once while the same fingerprint persists', () => {
    const reported = new Set<string>()
    expect(takeFreshConnectionWarnings(reported, 'a1', [dangling], 'fp1')).toEqual([dangling])
    expect(takeFreshConnectionWarnings(reported, 'a1', [dangling], 'fp1')).toEqual([])
  })

  it('re-alerts after the condition clears, even with the same fingerprint', () => {
    const reported = new Set<string>()
    takeFreshConnectionWarnings(reported, 'a1', [dangling], 'fp1')
    // Healthy resolution: no warnings ⇒ forget the episode.
    expect(takeFreshConnectionWarnings(reported, 'a1', [], 'fp-ok')).toEqual([])
    expect(takeFreshConnectionWarnings(reported, 'a1', [dangling], 'fp1')).toEqual([dangling])
  })

  it('re-alerts when the config fingerprint changes without a healthy gap', () => {
    const reported = new Set<string>()
    takeFreshConnectionWarnings(reported, 'a1', [dangling], 'fp1')
    expect(takeFreshConnectionWarnings(reported, 'a1', [dangling], 'fp2')).toEqual([dangling])
  })
})
