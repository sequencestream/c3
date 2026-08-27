import { describe, expect, it } from 'vitest'
import type { AgentConfig, ModelProvider, SystemSettings } from '@ccc/shared/protocol'
import {
  applyProviderMigration,
  clearInlineConnections,
  planProviderMigration,
  revertProviderMigration,
} from './provider-migration.js'

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

/** A claude agent still on the legacy inline triple. */
function inlineAgent(id: string, baseUrl: string, apiKey: string): AgentConfig {
  return agent({ id, configMode: 'custom', config: { baseUrl, apiKey, model: 'm' } })
}

function settings(agents: AgentConfig[], modelProviders: ModelProvider[] = []): SystemSettings {
  return {
    agents,
    modelProviders,
    defaultAgentId: agents[0]?.id ?? '',
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: '',
    specReviewAgentId: '',
    automationAgentId: '',
    degradationChain: [],
  }
}

describe('planProviderMigration', () => {
  it('collapses agents sharing an identical tuple onto one provider', () => {
    const plan = planProviderMigration(
      [
        inlineAgent('a1', 'https://api.deepseek.com/anthropic', 'sk-1'),
        inlineAgent('a2', 'https://api.deepseek.com/anthropic', 'sk-1'),
      ],
      [],
    )
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0].agentIds).toEqual(['a1', 'a2'])
    expect(plan.groups[0].displayName).toBe('Deepseek')
    expect(plan.groups[0].reusesExisting).toBe(false)
  })

  it('keeps agents with different keys on separate providers', () => {
    const plan = planProviderMigration(
      [
        inlineAgent('a1', 'https://api.deepseek.com', 'sk-1'),
        inlineAgent('a2', 'https://api.deepseek.com', 'sk-2'),
      ],
      [],
    )
    expect(plan.groups).toHaveLength(2)
    // Same host ⇒ the second name is disambiguated rather than colliding.
    expect(plan.groups.map((g) => g.displayName)).toEqual(['Deepseek', 'Deepseek (2)'])
  })

  it('reuses a hand-made provider whose connection matches the tuple', () => {
    const existing: ModelProvider = {
      id: 'mine',
      displayName: 'Mine',
      apiKey: 'sk-1',
      urls: { anthropic: 'https://api.deepseek.com' },
    }
    const plan = planProviderMigration(
      [inlineAgent('a1', 'https://api.deepseek.com', 'sk-1')],
      [existing],
    )
    expect(plan.groups[0]).toMatchObject({ providerId: 'mine', reusesExisting: true })
  })

  it('does not reuse a paused provider even when its connection matches the tuple', () => {
    const paused: ModelProvider = {
      id: 'mine',
      displayName: 'Mine',
      apiKey: 'sk-1',
      urls: { anthropic: 'https://api.deepseek.com' },
      paused: true,
    }
    const plan = planProviderMigration(
      [inlineAgent('a1', 'https://api.deepseek.com', 'sk-1')],
      [paused],
    )
    // A fresh (non-paused) provider is synthesized instead of pointing the agent
    // at an upstream the operator has taken offline.
    expect(plan.groups[0]).toMatchObject({ reusesExisting: false })
  })

  it('ignores system-mode agents, cursor agents and already-migrated ones', () => {
    const plan = planProviderMigration(
      [
        agent({
          id: 'sys',
          configMode: 'system',
          config: { baseUrl: 'https://x', apiKey: 'k', model: '' },
        }),
        agent({
          id: 'cur',
          vendor: 'cursor',
          configMode: 'system',
          config: { apiKey: 'k', model: '' },
        }),
        agent({
          id: 'done',
          providerId: 'p1',
          config: { baseUrl: 'https://x', apiKey: 'k', model: '' },
        }),
      ],
      [],
    )
    expect(plan.groups).toEqual([])
    // The migrated agent still carries a stale inline baseUrl ⇒ clearable.
    expect(plan.clearableAgentIds).toEqual(['done'])
  })
})

describe('applyProviderMigration', () => {
  it('creates the provider, points the agents at it and keeps the inline triple', () => {
    const before = settings([
      inlineAgent('a1', 'https://api.deepseek.com', 'sk-1'),
      inlineAgent('a2', 'https://api.deepseek.com', 'sk-1'),
    ])
    const { settings: after, appliedProviderIds } = applyProviderMigration(before)
    expect(appliedProviderIds).toHaveLength(1)
    const provider = after.modelProviders![0]
    expect(provider).toMatchObject({
      apiKey: 'sk-1',
      synthesized: true,
      urls: { anthropic: 'https://api.deepseek.com' },
    })
    expect(after.agents.map((a) => a.providerId)).toEqual([provider.id, provider.id])
    // Dual track: the inline triple is untouched, so the step stays reversible.
    expect(after.agents[0].config).toMatchObject({ baseUrl: 'https://api.deepseek.com' })
    // The input is not mutated.
    expect(before.agents[0].providerId).toBeUndefined()
  })

  it('is idempotent — a second plan over the applied settings is empty', () => {
    const { settings: after } = applyProviderMigration(
      settings([inlineAgent('a1', 'https://api.deepseek.com', 'sk-1')]),
    )
    expect(planProviderMigration(after.agents, after.modelProviders ?? []).groups).toEqual([])
  })

  it('reuses an existing provider instead of creating a duplicate', () => {
    const existing: ModelProvider = {
      id: 'mine',
      displayName: 'Mine',
      apiKey: 'sk-1',
      urls: { anthropic: 'https://api.deepseek.com' },
    }
    const { settings: after } = applyProviderMigration(
      settings([inlineAgent('a1', 'https://api.deepseek.com', 'sk-1')], [existing]),
    )
    expect(after.modelProviders).toHaveLength(1)
    expect(after.agents[0].providerId).toBe('mine')
  })

  it('honours the `only` filter', () => {
    const before = settings([
      inlineAgent('a1', 'https://one.example', 'sk-1'),
      inlineAgent('a2', 'https://two.example', 'sk-2'),
    ])
    const plan = planProviderMigration(before.agents, [])
    const { settings: after } = applyProviderMigration(before, [plan.groups[0].providerId])
    expect(after.modelProviders).toHaveLength(1)
    expect(after.agents[1].providerId).toBeUndefined()
  })
})

describe('revertProviderMigration', () => {
  it('restores the pre-migration state exactly', () => {
    const before = settings([inlineAgent('a1', 'https://api.deepseek.com', 'sk-1')])
    const { settings: applied } = applyProviderMigration(before)
    const reverted = revertProviderMigration(applied)
    expect(reverted.modelProviders).toEqual([])
    expect(reverted.agents[0].providerId).toBeUndefined()
    expect(reverted.agents[0].config).toEqual(before.agents[0].config)
  })

  it('never deletes a hand-made provider or unbinds its agents', () => {
    const existing: ModelProvider = {
      id: 'mine',
      displayName: 'Mine',
      apiKey: 'sk-1',
      urls: { anthropic: 'https://api.deepseek.com' },
    }
    const s = settings([agent({ id: 'a1', providerId: 'mine' })], [existing])
    expect(revertProviderMigration(s)).toEqual(s)
  })

  it('keeps a synthesized provider and its hand-bound agent, unbinding only the migrated one', () => {
    const { settings: applied } = applyProviderMigration(
      settings([inlineAgent('a1', 'https://api.deepseek.com', 'sk-1')]),
    )
    const providerId = applied.agents[0].providerId!
    // A3 is hand-bound to the synthesized provider afterward — the console's
    // provider dropdown does not distinguish synthesized from hand-made, and A3
    // never had an inline triple of its own to fall back to.
    const withHandBound: SystemSettings = {
      ...applied,
      agents: [
        ...applied.agents,
        agent({ id: 'a3', providerId, config: { baseUrl: '', apiKey: '', model: '' } }),
      ],
    }
    const reverted = revertProviderMigration(withHandBound)
    expect(reverted.agents.find((a) => a.id === 'a1')!.providerId).toBeUndefined()
    expect(reverted.agents.find((a) => a.id === 'a3')!.providerId).toBe(providerId)
    // The provider survives because a3 still references it.
    expect(reverted.modelProviders!.map((p) => p.id)).toEqual([providerId])
  })
})

describe('clearInlineConnections', () => {
  it('erases the dead inline connection but keeps the model override', () => {
    const { settings: applied } = applyProviderMigration(
      settings([inlineAgent('a1', 'https://api.deepseek.com', 'sk-1')]),
    )
    const cleared = clearInlineConnections(applied)
    expect(cleared.agents[0].config).toEqual({ baseUrl: '', apiKey: '', model: 'm' })
    expect(cleared.agents[0].providerId).toBe(applied.agents[0].providerId)
  })

  it('leaves un-migrated agents alone and returns the same settings reference', () => {
    const s = settings([inlineAgent('a1', 'https://api.deepseek.com', 'sk-1')])
    expect(clearInlineConnections(s)).toBe(s)
  })

  it('returns the same settings reference when every target is already clean', () => {
    const s = settings([
      agent({ id: 'a1', providerId: 'p1', config: { baseUrl: '', apiKey: '', model: 'm' } }),
    ])
    expect(clearInlineConnections(s)).toBe(s)
  })

  it('clears an apiKey-only residue that the plan also lists as clearable', () => {
    const s = settings([
      agent({
        id: 'a1',
        providerId: 'p1',
        config: { baseUrl: '', apiKey: 'leftover', model: 'm' },
      }),
    ])
    expect(planProviderMigration(s.agents, []).clearableAgentIds).toEqual(['a1'])
    const cleared = clearInlineConnections(s)
    expect(cleared.agents[0].config).toEqual({ baseUrl: '', apiKey: '', model: 'm' })
  })
})
