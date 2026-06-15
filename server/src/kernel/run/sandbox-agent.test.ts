/**
 * Unit tests for {@link pickSandboxAgent} — the random sandbox agent selector
 * (ADR-0024). Covers: random selection from the pool, the empty-pool / deleted /
 * non-claude hard-fail reasons, and deterministic index math via the injected RNG.
 */
import { describe, it, expect } from 'vitest'
import type { VendorId } from '@ccc/shared/protocol'
import { pickSandboxAgent } from './sandbox-agent.js'

/** One agent's resolved shell: its vendor, plus (for codex) its provider wireApi. */
type Entry = { vendor: VendorId; wireApi?: 'responses' | 'chat' }

/** A resolver over a fixed agent table; unknown ids fall back to a default agent. */
function resolverOver(
  table: Record<string, VendorId | Entry>,
  fallbackId = 'default-agent',
): (id: string) => { id: string; vendor: VendorId; wireApi?: 'responses' | 'chat' } {
  return (id) => {
    const e = table[id]
    if (!e) return { id: fallbackId, vendor: 'claude' }
    return typeof e === 'string' ? { id, vendor: e } : { id, ...e }
  }
}

describe('pickSandboxAgent', () => {
  it('picks a claude agent from the pool and reports its id', () => {
    const resolve = resolverOver({ a: 'claude', b: 'claude' })
    const result = pickSandboxAgent(['a', 'b'], resolve, () => 0)
    expect(result).toEqual({ ok: true, agentId: 'a' })
  })

  it('uses the injected RNG to index the pool (random selection)', () => {
    const resolve = resolverOver({ a: 'claude', b: 'claude', c: 'claude' })
    // rand=0.9 → floor(0.9*3)=2 → 'c'
    expect(pickSandboxAgent(['a', 'b', 'c'], resolve, () => 0.9)).toEqual({
      ok: true,
      agentId: 'c',
    })
    // rand=0.5 → floor(0.5*3)=1 → 'b'
    expect(pickSandboxAgent(['a', 'b', 'c'], resolve, () => 0.5)).toEqual({
      ok: true,
      agentId: 'b',
    })
  })

  it('clamps a rand of 1 to the last index (never out of range)', () => {
    const resolve = resolverOver({ a: 'claude', b: 'claude' })
    expect(pickSandboxAgent(['a', 'b'], resolve, () => 1)).toEqual({ ok: true, agentId: 'b' })
  })

  it('hard-fails with empty-pool when the pool is empty', () => {
    const resolve = resolverOver({})
    expect(pickSandboxAgent([], resolve, () => 0)).toEqual({ ok: false, reason: 'empty-pool' })
  })

  it('hard-fails with unavailable when the picked agent was deleted', () => {
    // 'ghost' is not in the table → resolver falls back to a different id.
    const resolve = resolverOver({ a: 'claude' })
    expect(pickSandboxAgent(['ghost'], resolve, () => 0)).toEqual({
      ok: false,
      reason: 'unavailable',
      agentId: 'ghost',
    })
  })

  it('admits a codex DIRECT agent (wireApi=responses)', () => {
    const resolve = resolverOver({ cod: { vendor: 'codex', wireApi: 'responses' } })
    expect(pickSandboxAgent(['cod'], resolve, () => 0)).toEqual({ ok: true, agentId: 'cod' })
  })

  it('admits a codex RELAY agent (wireApi=chat) — reaches the relay via host.docker.internal', () => {
    const resolve = resolverOver({ cod: { vendor: 'codex', wireApi: 'chat' } })
    expect(pickSandboxAgent(['cod'], resolve, () => 0)).toEqual({ ok: true, agentId: 'cod' })
  })

  it('hard-fails with unsupported-wire for system-login codex (wireApi absent)', () => {
    const resolve = resolverOver({ cod: { vendor: 'codex' } })
    expect(pickSandboxAgent(['cod'], resolve, () => 0)).toEqual({
      ok: false,
      reason: 'unsupported-wire',
      agentId: 'cod',
    })
  })
})
