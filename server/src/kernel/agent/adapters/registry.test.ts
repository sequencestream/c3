/**
 * Unit coverage for the host-binary-gated adapter registry (ADR-0012).
 *
 * The gate is proven by injecting `resolve` — no real `claude` CLI required. The
 * invariants: a missing host binary keeps the vendor OUT of `available` and puts
 * it in `missing` WITH a non-empty install hint; a present binary registers it.
 */
import { describe, expect, it } from 'vitest'
import { resolveAvailableAdapters } from './registry.js'

describe('resolveAvailableAdapters', () => {
  it('drops a vendor from `available` and lists it in `missing` when its host CLI is absent', () => {
    const { available, missing } = resolveAvailableAdapters(() => null)

    expect(available.map((a) => a.vendor)).not.toContain('claude')
    const claudeMissing = missing.find((m) => m.vendor === 'claude')
    expect(claudeMissing).toBeDefined()
    expect(claudeMissing?.binary).toBe('claude')
    expect(claudeMissing?.installHint.length).toBeGreaterThan(0)
  })

  it('registers the vendor adapter when its host CLI resolves', () => {
    const { available, missing } = resolveAvailableAdapters(() => '/usr/local/bin/claude')

    const claude = available.find((a) => a.vendor === 'claude')
    expect(claude).toBeDefined()
    // A real VendorAdapter, fully assembled (driver/approval/sessions present).
    expect(claude?.driver.vendor).toBe('claude')
    expect(claude?.capabilities.perToolApproval).toBe(true)
    expect(missing.map((m) => m.vendor)).not.toContain('claude')
  })

  it('does not construct the adapter when probing fails (probe is the front gate)', () => {
    // If the factory ran despite a null probe, `createClaudeAdapter` would appear
    // in `available`. It must not.
    const { available } = resolveAvailableAdapters(() => null)
    expect(available).toHaveLength(0)
  })
})
