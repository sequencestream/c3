import { beforeEach, describe, it, expect, vi } from 'vitest'
import { VENDOR_IDS } from '@ccc/shared/protocol'

/**
 * The neutral availability derivation. Every vendor is backed by a host CLI, so
 * the answer comes from one probe — what varies between them is only where the
 * binary came from, which travels as provenance and gates nothing. DSH adds one
 * engine check: the Node.js on PATH that its shebang will run.
 */

const gate = vi.hoisted(() => ({
  dshPath: null as string | null,
  nodeVersion: null as string | null,
  nodeReads: 0,
}))

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
      {
        vendor: 'dsh',
        binary: 'dsh',
        path: gate.dshPath,
        source: gate.dshPath ? 'managed' : 'missing',
      },
    ] as never,
  isManagedVendor: (vendor: string) =>
    vendor === 'claude' || vendor === 'codex' || vendor === 'cursor' || vendor === 'dsh',
}))

vi.mock('./adapters/dsh/node-engine.js', async () => {
  const actual = await vi.importActual<typeof import('./adapters/dsh/node-engine.js')>(
    './adapters/dsh/node-engine.js',
  )
  return {
    ...actual,
    pathNodeVersion: () => {
      gate.nodeReads += 1
      return gate.nodeVersion
    },
  }
})

import { availableVendorSet, vendorRuntimeStatuses } from './vendor-runtime.js'

beforeEach(() => {
  gate.dshPath = null
  gate.nodeVersion = null
  gate.nodeReads = 0
})

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

describe('dsh node engine', () => {
  it('does not consult node when the dsh CLI is missing', () => {
    gate.nodeVersion = 'v22.10.0'
    const dsh = vendorRuntimeStatuses().dsh
    expect(dsh.available).toBe(false)
    expect(dsh.reason).toBe('host-cli-missing')
    expect(gate.nodeReads).toBe(0)
  })

  it('rejects a PATH node below the dsh engine', () => {
    gate.dshPath = '/x/dsh'
    gate.nodeVersion = 'v24.3.0'
    const dsh = vendorRuntimeStatuses().dsh
    expect(dsh).toMatchObject({ available: false, reason: 'node-engine-incompatible' })
    expect(dsh.origin).toBeUndefined()
    expect(dsh.location).toBeUndefined()
    expect(availableVendorSet().has('dsh')).toBe(false)
  })

  it('accepts a PATH node that meets the engine', () => {
    gate.dshPath = '/x/dsh'
    gate.nodeVersion = 'v26.13.0'
    expect(vendorRuntimeStatuses().dsh).toMatchObject({
      available: true,
      origin: 'installed',
      location: '/x/dsh',
      runtimeId: 'dsh',
    })
    expect(availableVendorSet().has('dsh')).toBe(true)
  })

  it('treats a missing PATH node as engine-incompatible', () => {
    gate.dshPath = '/x/dsh'
    gate.nodeVersion = null
    expect(vendorRuntimeStatuses().dsh.reason).toBe('node-engine-incompatible')
  })
})
