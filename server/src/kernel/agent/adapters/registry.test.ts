/**
 * Unit coverage for the host-binary-gated adapter registry (ADR-0012).
 *
 * The gate is proven by injecting `resolve` — no real `claude` CLI required. The
 * invariants: a missing host binary keeps the vendor OUT of `available` and puts
 * it in `missing` WITH a non-empty install hint; a present binary registers it.
 */
import { describe, expect, it } from 'vitest'
import { resolveAvailableAdapters } from './registry.js'
import type { VendorId } from './types.js'
import type { VendorProbe } from '../process/launcher.js'

function probe(vendor: VendorId, path: string | null): VendorProbe {
  return {
    vendor,
    binary: vendor,
    path,
    source: path ? 'managed' : 'missing',
    present: path !== null,
    compatibleRange: '>=0.0.0 <999.0.0',
    installHint: `install ${vendor}`,
  }
}

describe('resolveAvailableAdapters', () => {
  it('drops a vendor from `available` and lists it in `missing` when its host CLI is absent', () => {
    const { available, missing } = resolveAvailableAdapters((v) => probe(v, null))

    expect(available.map((a) => a.vendor)).not.toContain('claude')
    const claudeMissing = missing.find((m) => m.vendor === 'claude')
    expect(claudeMissing).toBeDefined()
    expect(claudeMissing?.binary).toBe('claude')
    expect(claudeMissing?.installHint.length).toBeGreaterThan(0)
  })

  it('registers the vendor adapter when its host CLI resolves', () => {
    const { available, missing } = resolveAvailableAdapters((v) => probe(v, `/usr/local/bin/${v}`))

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
    const { available } = resolveAvailableAdapters((v) => probe(v, null))
    expect(available).toHaveLength(0)
  })

  // ── Codex no-arg factory (2026-06-06-005) ───────────────────────────────────
  it('registers the codex adapter (read-only advisor, all-false ledger) when its CLI resolves', () => {
    const { available, missing } = resolveAvailableAdapters((v) =>
      probe(v, v === 'codex' ? '/usr/local/bin/codex' : null),
    )
    const codex = available.find((a) => a.vendor === 'codex')
    expect(codex).toBeDefined()
    expect(codex?.driver.vendor).toBe('codex')
    // Faithful to Phase 0 (008 NO-GO): no per-tool approval.
    expect(codex?.capabilities.perToolApproval).toBe(false)
    expect(missing.map((m) => m.vendor)).not.toContain('codex')
  })

  it('lists codex in `missing` when its host CLI is absent', () => {
    const { missing } = resolveAvailableAdapters((v) => probe(v, null))
    const codexMissing = missing.find((m) => m.vendor === 'codex')
    expect(codexMissing).toBeDefined()
    expect(codexMissing?.binary).toBe('codex')
    expect(codexMissing?.installHint.length).toBeGreaterThan(0)
  })
})
