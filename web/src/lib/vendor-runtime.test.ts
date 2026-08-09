import { describe, it, expect } from 'vitest'
import { VENDOR_IDS } from '@ccc/shared/protocol'
import type { VendorHostStatus, VendorRuntimeStatus } from '@ccc/shared/protocol'
import {
  deriveVendorAvailability,
  vendorRuntimeOriginKey,
  vendorUnavailableReasonKey,
} from './vendor-runtime'

const CLAUDE_HOST: VendorHostStatus = {
  vendor: 'claude',
  present: true,
  binary: 'claude',
  path: '/usr/local/bin/claude',
  installHint: '',
}
const CODEX_HOST_MISSING: VendorHostStatus = {
  vendor: 'codex',
  present: false,
  binary: 'codex',
  path: null,
  installHint: 'install codex',
}

describe('deriveVendorAvailability', () => {
  it('answers for every registered vendor', () => {
    const out = deriveVendorAvailability(undefined, [])
    expect(Object.keys(out).sort()).toEqual([...VENDOR_IDS].sort())
  })

  it('passes the server signal through verbatim when present', () => {
    const cursor: VendorRuntimeStatus = {
      vendor: 'cursor',
      available: true,
      runtime: 'host-cli',
      runtimeId: 'cursor-agent',
      origin: 'host-path',
    }
    // The host probe says nothing about cursor; the neutral signal decides.
    const out = deriveVendorAvailability({ cursor }, [CLAUDE_HOST])
    expect(out.cursor).toEqual(cursor)
  })

  it('falls back to hostStatus for CLI vendors on a server that omits the signal', () => {
    const out = deriveVendorAvailability(undefined, [CLAUDE_HOST, CODEX_HOST_MISSING])
    expect(out.claude).toEqual({
      vendor: 'claude',
      available: true,
      runtime: 'host-cli',
      runtimeId: 'claude',
    })
    expect(out.codex).toEqual({
      vendor: 'codex',
      available: false,
      runtime: 'host-cli',
      runtimeId: 'codex',
      reason: 'host-cli-missing',
    })
  })

  it('treats a vendor the old server cannot describe as unavailable, never as available', () => {
    // The fail-closed direction: an old server may not describe every vendor, so
    // the console must not let the user into a path that would fail at launch.
    const out = deriveVendorAvailability(undefined, [CLAUDE_HOST, CODEX_HOST_MISSING])
    expect(out.cursor).toEqual({
      vendor: 'cursor',
      available: false,
      runtime: 'host-cli',
      reason: 'host-cli-missing',
    })
  })

  it('mixes: a per-vendor signal wins, the rest still fall back', () => {
    const out = deriveVendorAvailability(
      { codex: { vendor: 'codex', available: true, runtime: 'host-cli', runtimeId: 'codex' } },
      [CLAUDE_HOST, CODEX_HOST_MISSING],
    )
    expect(out.codex.available).toBe(true)
    expect(out.claude.available).toBe(true)
    expect(out.cursor.available).toBe(false)
  })
})

describe('vendorUnavailableReasonKey', () => {
  it('maps each reason code to its own localizable key', () => {
    expect(
      vendorUnavailableReasonKey({
        vendor: 'codex',
        available: false,
        runtime: 'host-cli',
        reason: 'host-cli-missing',
      }),
    ).toBe('common.vendor.unavailable.hostCliMissing')
  })

  it('returns null for an available vendor or a missing entry', () => {
    expect(
      vendorUnavailableReasonKey({ vendor: 'claude', available: true, runtime: 'host-cli' }),
    ).toBeNull()
    expect(vendorUnavailableReasonKey(undefined)).toBeNull()
  })
})

describe('vendorRuntimeOriginKey', () => {
  it('maps each resolution source to its own localizable key', () => {
    const cursor = (origin: VendorRuntimeStatus['origin']): VendorRuntimeStatus => ({
      vendor: 'cursor',
      available: true,
      runtime: 'host-cli',
      runtimeId: 'cursor-agent',
      origin,
    })
    expect(vendorRuntimeOriginKey(cursor('installed'))).toBe('common.vendor.origin.installed')
    expect(vendorRuntimeOriginKey(cursor('host-path'))).toBe('common.vendor.origin.hostPath')
    expect(vendorRuntimeOriginKey(cursor('override'))).toBe('common.vendor.origin.override')
  })

  it('says nothing when the vendor cannot run — provenance of a missing runtime is noise', () => {
    expect(
      vendorRuntimeOriginKey({
        vendor: 'cursor',
        available: false,
        runtime: 'host-cli',
        reason: 'host-cli-missing',
      }),
    ).toBeNull()
    expect(
      vendorRuntimeOriginKey({ vendor: 'claude', available: true, runtime: 'host-cli' }),
    ).toBeNull()
    expect(vendorRuntimeOriginKey(undefined)).toBeNull()
  })
})
