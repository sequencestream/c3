/**
 * Unit coverage for the host-binary-gated adapter registry (ADR-0012).
 *
 * The gate is proven by injecting `resolve` — no real `claude` CLI required. The
 * invariants: a missing host binary keeps the vendor OUT of `available` and puts
 * it in `missing` WITH a non-empty install hint; a present binary registers it.
 */
import { describe, expect, it } from 'vitest'
import { resolveAvailableAdapters } from './registry.js'
import type { VendorAdapter } from './types.js'

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

  // ── Codex no-arg factory (2026-06-06-005) ───────────────────────────────────
  it('registers the codex adapter (read-only advisor, all-false ledger) when its CLI resolves', () => {
    const { available, missing } = resolveAvailableAdapters((v) =>
      v === 'codex' ? '/usr/local/bin/codex' : null,
    )
    const codex = available.find((a) => a.vendor === 'codex')
    expect(codex).toBeDefined()
    expect(codex?.driver.vendor).toBe('codex')
    // Faithful to Phase 0 (008 NO-GO): no per-tool approval.
    expect(codex?.capabilities.perToolApproval).toBe(false)
    expect(missing.map((m) => m.vendor)).not.toContain('codex')
  })

  it('lists codex in `missing` when its host CLI is absent', () => {
    const { missing } = resolveAvailableAdapters(() => null)
    const codexMissing = missing.find((m) => m.vendor === 'codex')
    expect(codexMissing).toBeDefined()
    expect(codexMissing?.binary).toBe('codex')
    expect(codexMissing?.installHint.length).toBeGreaterThan(0)
  })

  // ── OpenCode injection (2026-06-06-003) ──────────────────────────────────────
  const fakeOpencode = { vendor: 'opencode' } as unknown as VendorAdapter

  it('registers the injected opencode adapter when its host CLI resolves', () => {
    const { available } = resolveAvailableAdapters(
      (v) => (v === 'opencode' ? '/bin/opencode' : null),
      {
        adapter: fakeOpencode,
        external: false,
      },
    )
    expect(available.map((a) => a.vendor)).toContain('opencode')
  })

  it('lists opencode in `missing` when its host CLI is absent and not external', () => {
    const { available, missing } = resolveAvailableAdapters(() => null, {
      adapter: fakeOpencode,
      external: false,
    })
    expect(available.map((a) => a.vendor)).not.toContain('opencode')
    expect(missing.map((m) => m.vendor)).toContain('opencode')
  })

  it('external opencode (--opencode-url) bypasses the host-binary gate', () => {
    const { available, missing } = resolveAvailableAdapters(() => null, {
      adapter: fakeOpencode,
      external: true,
    })
    expect(available.map((a) => a.vendor)).toContain('opencode')
    expect(missing.map((m) => m.vendor)).not.toContain('opencode')
  })
})
