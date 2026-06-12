/**
 * `buildAgentsToTry` — the vendor-homogeneous degradation-chain builder
 * (2026-06-06-006). Pins: same-vendor fallbacks are kept in order (deduped, self
 * excluded); cross-vendor fallbacks are dropped into `crossVendorSkipped` (they
 * cannot carry context); an absent chain yields just attempt 0.
 */
import { describe, it, expect } from 'vitest'
import type { AgentConfig } from '@ccc/shared/protocol'
import { buildAgentsToTry } from './build-chain.js'

const agent = (id: string, vendor: AgentConfig['vendor']): AgentConfig =>
  ({
    id,
    vendor,
    configMode: 'custom',
    displayName: id.toUpperCase(),
    // codex carries the extra `wireApi`; the other arms take the bare triple. The
    // discriminant is a runtime variable here, so the union can't be narrowed —
    // cast through the per-vendor config shape.
    config:
      vendor === 'codex'
        ? { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' as const }
        : { baseUrl: '', apiKey: '', model: '' },
  }) as AgentConfig

const REGISTRY: Record<string, AgentConfig> = {
  c1: agent('c1', 'claude'),
  c2: agent('c2', 'claude'),
  oc: agent('oc', 'opencode'),
  cx: agent('cx', 'codex'),
}
const resolve = (id: string): AgentConfig => REGISTRY[id] ?? agent(id, 'claude')
// A launch mapper that tags the model so order/identity is observable.
const launch = (a: AgentConfig): { model?: string } => ({ model: `model-${a.id}` })

const first = { agentId: 'c1', model: 'model-c1' }

describe('buildAgentsToTry — vendor-homogeneous chain', () => {
  it('keeps same-vendor fallbacks in order; entry 0 is always the session agent', () => {
    const { agentsToTry, crossVendorSkipped } = buildAgentsToTry(
      first,
      'claude',
      ['c2'],
      resolve,
      launch,
    )
    expect(agentsToTry.map((a) => a.agentId)).toEqual(['c1', 'c2'])
    expect(crossVendorSkipped).toEqual([])
  })

  it('skips cross-vendor fallbacks and reports them', () => {
    const { agentsToTry, crossVendorSkipped } = buildAgentsToTry(
      first,
      'claude',
      ['oc', 'c2', 'cx'],
      resolve,
      launch,
    )
    // Only the same-vendor (claude) c2 is kept after c1.
    expect(agentsToTry.map((a) => a.agentId)).toEqual(['c1', 'c2'])
    expect(crossVendorSkipped).toEqual([
      { agentId: 'oc', agentName: 'OC', vendor: 'opencode' },
      { agentId: 'cx', agentName: 'CX', vendor: 'codex' },
    ])
  })

  it('drops the session agent and duplicates from the chain', () => {
    const { agentsToTry, crossVendorSkipped } = buildAgentsToTry(
      first,
      'claude',
      ['c1', 'c2', 'c2'],
      resolve,
      launch,
    )
    expect(agentsToTry.map((a) => a.agentId)).toEqual(['c1', 'c2'])
    expect(crossVendorSkipped).toEqual([])
  })

  it('yields only attempt 0 when the chain is absent', () => {
    const { agentsToTry, crossVendorSkipped } = buildAgentsToTry(
      first,
      'claude',
      undefined,
      resolve,
      launch,
    )
    expect(agentsToTry.map((a) => a.agentId)).toEqual(['c1'])
    expect(crossVendorSkipped).toEqual([])
  })

  it('an all-cross-vendor chain leaves no real degradation but records every skip', () => {
    const { agentsToTry, crossVendorSkipped } = buildAgentsToTry(
      first,
      'claude',
      ['oc', 'cx'],
      resolve,
      launch,
    )
    expect(agentsToTry.map((a) => a.agentId)).toEqual(['c1'])
    expect(crossVendorSkipped.map((a) => a.agentId)).toEqual(['oc', 'cx'])
  })

  it('anchors on the session vendor — an opencode session keeps opencode fallbacks', () => {
    const { agentsToTry, crossVendorSkipped } = buildAgentsToTry(
      { agentId: 'oc', model: 'model-oc' },
      'opencode',
      ['c1', 'oc'],
      resolve,
      launch,
    )
    // c1 (claude) is cross-vendor for an opencode session → skipped; oc == self → dropped.
    expect(agentsToTry.map((a) => a.agentId)).toEqual(['oc'])
    expect(crossVendorSkipped).toEqual([{ agentId: 'c1', agentName: 'C1', vendor: 'claude' }])
  })
})
