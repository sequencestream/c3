/**
 * Vendor registration coverage contract.
 *
 * Adding a vendor touches many registration surfaces, several of which are only
 * `Partial`/runtime-keyed and so do NOT fail to compile when a vendor is missed.
 * This test walks the authoritative {@link VENDOR_IDS} list and asserts every
 * vendor — cursor included — has an explicit entry in each surface, and that the
 * "no silent fallback" seams route cursor to its own path rather than borrowing
 * another vendor's. A new vendor that forgets a surface fails here at test time.
 */
import { describe, expect, it } from 'vitest'
import { VENDOR_IDS } from '@ccc/shared/protocol'
import { VENDOR_CAPABILITIES } from './capabilities.js'
import { MODE_CATALOGS } from './index.js'
import { HOST_BINARIES, isManagedVendor, managedVendorSpecs } from '../process/launcher.js'
import { VENDOR_AUTH_PROFILES } from '../../sandbox/vendor-auth.js'
import { VENDOR_AGENT_SCHEMAS, agentConfigSchema } from '../../agent-config/schema.js'
import {
  resolveVendorStoreDir,
  hostClaudeConfigDir,
  hostCursorHome,
} from '../../config/workspace-path.js'
import { normalizeToolRequest } from '../../permission/risk.js'

const VENDORS = [...VENDOR_IDS]

/**
 * Vendors c3 drives through an in-process SDK rather than a host CLI. They have
 * no binary descriptor and no arapuca auth profile by design, so the coverage
 * assertions below exempt exactly these — and nothing else.
 */
const SDK_EMBEDDED_VENDORS: string[] = ['cursor']

describe('vendor registration coverage', () => {
  it('cursor is a registered vendor', () => {
    expect(VENDORS).toContain('cursor')
  })

  it.each(VENDORS)('%s has a capability ledger', (vendor) => {
    expect(VENDOR_CAPABILITIES[vendor]).toBeDefined()
    expect(Object.keys(VENDOR_CAPABILITIES[vendor].sessions).sort()).toEqual([
      'delete',
      'list',
      'read',
      'rename',
      'resume',
    ])
  })

  it.each(VENDORS)('%s has a mode catalog whose defaultToken is one of its modes', (vendor) => {
    const catalog = MODE_CATALOGS[vendor]
    expect(catalog).toBeDefined()
    expect(catalog.vendor).toBe(vendor)
    expect(catalog.modes.length).toBeGreaterThan(0)
    expect(catalog.modes.map((m) => m.token)).toContain(catalog.defaultToken)
  })

  it.each(VENDORS)('%s either has a host-CLI descriptor or runs on an in-process SDK', (vendor) => {
    const spec = HOST_BINARIES[vendor]
    // A vendor c3 launches as a CLI must describe how to install it; one that runs
    // in-process must be absent here rather than carry a spec for a binary that is
    // never launched. Both are legal — silence in between is not.
    if (spec) {
      expect(spec.vendor).toBe(vendor)
      expect(spec.installHint.length).toBeGreaterThan(0)
    } else {
      expect(SDK_EMBEDDED_VENDORS).toContain(vendor)
    }
  })

  it.each(VENDORS)('%s has a sandbox auth profile iff it is launched as a host CLI', (vendor) => {
    // arapuca narrows a child process; an in-process SDK has none to narrow, so it
    // isolates through its own runtime and registers no profile here.
    const expected = HOST_BINARIES[vendor] !== undefined
    expect(VENDOR_AUTH_PROFILES[vendor] !== undefined).toBe(expected)
  })

  it.each(VENDORS)('%s has an agent-config schema arm', (vendor) => {
    expect(VENDOR_AGENT_SCHEMAS[vendor]).toBeDefined()
  })

  it('the capability/mode/binary/auth/schema maps cover exactly the registered vendors', () => {
    const expected = [...VENDORS].sort()
    expect(Object.keys(VENDOR_CAPABILITIES).sort()).toEqual(expected)
    expect(Object.keys(MODE_CATALOGS).sort()).toEqual(expected)
    const hostCliVendors = expected.filter((v) => !SDK_EMBEDDED_VENDORS.includes(v))
    expect(Object.keys(HOST_BINARIES).sort()).toEqual(hostCliVendors)
    expect(Object.keys(VENDOR_AUTH_PROFILES).sort()).toEqual(hostCliVendors)
    expect(Object.keys(VENDOR_AGENT_SCHEMAS).sort()).toEqual(expected)
  })
})

describe('cursor-specific registration facts', () => {
  it('cursor runs on the in-process SDK, so it has no host CLI to install or version', () => {
    expect(HOST_BINARIES.cursor).toBeUndefined()
    expect(isManagedVendor('cursor')).toBe(false)
    expect(managedVendorSpecs().map((s) => s.vendor)).not.toContain('cursor')
  })

  it('cursor declares no per-tool approval, in-process MCP, task store, or native user input', () => {
    const caps = VENDOR_CAPABILITIES.cursor
    expect(caps.perToolApproval).toBe(false)
    expect(caps.inProcessMcp).toBe(false)
    expect(caps.taskStore).toBe(false)
    expect(caps.nativeUserInput).toBe(false)
    // Resume is native and proven; list/read see only what ran through the SDK.
    expect(caps.sessions.resume).toBe('full')
    expect(caps.sessions.list).toBe('partial')
    expect(caps.sessions.read).toBe('partial')
  })

  it('cursor offers a plan mode backed by the SDK plan conversation mode', () => {
    const plan = MODE_CATALOGS.cursor.modes.find((m) => m.token === 'plan')
    expect(plan?.actionMode).toBe('plan')
    // Only the explicit full-access preset drops the tool gate.
    expect(MODE_CATALOGS.cursor.modes.filter((m) => m.toolGate === 'never-ask')).toHaveLength(1)
  })

  it('cursor store dir is its own data root, not Claude’s', () => {
    const cursorDir = resolveVendorStoreDir('cursor', '/ws', 'host')
    expect(cursorDir).toBe(hostCursorHome())
    expect(cursorDir).not.toBe(hostClaudeConfigDir())
  })

  it('the agent-config schema accepts a cursor agent with an api key and rejects a provider triple', () => {
    const ok = agentConfigSchema.safeParse({
      id: 'a',
      vendor: 'cursor',
      configMode: 'system',
      displayName: 'Cursor',
      config: { apiKey: 'key_123' },
    })
    expect(ok.success).toBe(true)
    // The key is the only legal field — a provider triple is rejected, because c3
    // has no relay that could honour one.
    const bad = agentConfigSchema.safeParse({
      id: 'a',
      vendor: 'cursor',
      configMode: 'custom',
      displayName: 'Cursor',
      config: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    })
    expect(bad.success).toBe(false)
  })
})

describe('no silent fallback for cursor', () => {
  it('an unknown vendor is rejected by the config schema', () => {
    const result = agentConfigSchema.safeParse({
      id: 'a',
      vendor: 'not-a-vendor',
      configMode: 'system',
      displayName: 'X',
      config: {},
    })
    expect(result.success).toBe(false)
  })

  it('cursor risk classification fails closed on an unknown tool', () => {
    // A known cursor tool normalizes; an unknown one is refused, never approximated.
    const known = normalizeToolRequest('cursor', 'read', { path: '/a/b.txt' })
    expect(known.ok).toBe(true)
    const unknown = normalizeToolRequest('cursor', 'mysteryTool', { x: 1 })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toBe('unknown-tool')
  })
})
