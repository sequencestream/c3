import { describe, it, expect, vi } from 'vitest'
import { VENDOR_IDS } from '@ccc/shared/protocol'

/**
 * The neutral availability derivation. Every vendor is backed by a host CLI, so
 * the answer comes from one probe — what varies between them is only where the
 * binary came from, which travels as provenance and gates nothing.
 */

vi.mock('./process/launcher.js', () => ({
  probeAll: () =>
    [
      { vendor: 'claude', binary: 'claude', path: '/x/claude', source: 'managed' },
      { vendor: 'codex', binary: 'codex', path: null, source: 'missing' },
      {
        vendor: 'cursor',
        binary: 'cursor-agent',
        path: '/home/u/.local/bin/cursor-agent',
        source: 'host-path-fallback',
      },
    ] as never,
  isManagedVendor: (vendor: string) =>
    vendor === 'claude' || vendor === 'codex' || vendor === 'cursor',
}))

import { availableVendorSet, vendorRuntimeStatuses } from './vendor-runtime.js'

describe('vendorRuntimeStatuses', () => {
  it('answers for every registered vendor in the same terms', () => {
    const statuses = vendorRuntimeStatuses()
    expect(Object.keys(statuses).sort()).toEqual([...VENDOR_IDS].sort())
    expect(statuses.claude.runtime).toBe('host-cli')
    expect(statuses.cursor.runtime).toBe('host-cli')
  })

  it('reports availability and the missing-CLI reason from the probe', () => {
    const statuses = vendorRuntimeStatuses()
    expect(statuses.claude.available).toBe(true)
    expect(statuses.codex.available).toBe(false)
    expect(statuses.codex.reason).toBe('host-cli-missing')
  })

  it('names the binary and where it was found, so availability is never just a claim', () => {
    const cursor = vendorRuntimeStatuses().cursor
    expect(cursor).toMatchObject({
      available: true,
      runtimeId: 'cursor-agent',
      // Distributed by the vendor, found on PATH — not something c3 installed.
      origin: 'host-path',
      location: '/home/u/.local/bin/cursor-agent',
    })
    expect(vendorRuntimeStatuses().claude.origin).toBe('installed')
  })

  it('carries no provenance for a vendor that did not resolve', () => {
    const codex = vendorRuntimeStatuses().codex
    expect(codex.origin).toBeUndefined()
    expect(codex.location).toBeUndefined()
  })
})

describe('availableVendorSet', () => {
  it('is exactly the vendors whose CLI resolved', () => {
    expect(availableVendorSet()).toEqual(new Set(['claude', 'cursor']))
  })
})
