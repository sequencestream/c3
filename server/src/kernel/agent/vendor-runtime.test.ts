import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VENDOR_IDS } from '@ccc/shared/protocol'

/**
 * The neutral availability derivation, and the reason it exists: a session bound
 * to a vendor whose runtime is an in-process SDK must not be reported as
 * "unavailable" just because the host-CLI probe has nothing to say about it.
 */

vi.mock('./process/launcher.js', () => ({
  probeAll: () =>
    [
      { vendor: 'claude', binary: 'claude', path: '/x/claude' },
      { vendor: 'codex', binary: 'codex', path: null },
    ] as never,
  isManagedVendor: (vendor: string) => vendor === 'claude' || vendor === 'codex',
}))

const sdk = vi.hoisted(() => ({ available: true }))
vi.mock('./adapters/index.js', () => ({
  EMBEDDED_RUNTIME_PROBES: {
    cursor: { module: '@cursor/sdk', available: () => sdk.available },
  },
}))

import { availableVendorSet, vendorRuntimeStatuses } from './vendor-runtime.js'

beforeEach(() => {
  sdk.available = true
})

describe('vendorRuntimeStatuses', () => {
  it('answers for every registered vendor, whichever runtime backs it', () => {
    const statuses = vendorRuntimeStatuses()
    expect(Object.keys(statuses).sort()).toEqual([...VENDOR_IDS].sort())
    expect(statuses.claude.runtime).toBe('host-cli')
    expect(statuses.cursor.runtime).toBe('embedded-sdk')
  })

  it('keeps CLI vendors on the CLI probe', () => {
    const statuses = vendorRuntimeStatuses()
    expect(statuses.claude.available).toBe(true)
    expect(statuses.codex.available).toBe(false)
    expect(statuses.codex.reason).toBe('host-cli-missing')
  })

  it('follows the embedded probe for an SDK vendor, in both directions', () => {
    expect(vendorRuntimeStatuses().cursor.available).toBe(true)
    sdk.available = false
    const off = vendorRuntimeStatuses().cursor
    expect(off.available).toBe(false)
    expect(off.reason).toBe('sdk-unresolved')
  })
})

describe('availableVendorSet', () => {
  it('includes an SDK-backed vendor the CLI probe knows nothing about', () => {
    // This is the whole point: gating on the CLI probe alone would drop cursor
    // and make a running Cursor session report "current agent unavailable".
    expect(availableVendorSet()).toEqual(new Set(['claude', 'cursor']))
  })

  it('drops the SDK vendor when its runtime is gone', () => {
    sdk.available = false
    expect(availableVendorSet()).toEqual(new Set(['claude']))
  })
})
