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
import { HOST_BINARIES } from '../process/launcher.js'
import { VENDOR_AUTH_PROFILES } from '../../sandbox/vendor-auth.js'
import { VENDOR_AGENT_SCHEMAS, agentConfigSchema } from '../../agent-config/schema.js'
import {
  resolveVendorStoreDir,
  hostClaudeConfigDir,
  hostCursorHome,
} from '../../config/workspace-path.js'
import { normalizeToolRequest } from '../../permission/risk.js'

const VENDORS = [...VENDOR_IDS]

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

  it.each(VENDORS)('%s has a binary descriptor with an install hint', (vendor) => {
    const spec = HOST_BINARIES[vendor]
    expect(spec).toBeDefined()
    expect(spec.vendor).toBe(vendor)
    expect(spec.installHint.length).toBeGreaterThan(0)
  })

  it.each(VENDORS)('%s has a sandbox auth profile', (vendor) => {
    expect(VENDOR_AUTH_PROFILES[vendor]).toBeTypeOf('function')
  })

  it.each(VENDORS)('%s has an agent-config schema arm', (vendor) => {
    expect(VENDOR_AGENT_SCHEMAS[vendor]).toBeDefined()
  })

  it('the capability/mode/binary/auth/schema maps cover exactly the registered vendors', () => {
    const expected = [...VENDORS].sort()
    expect(Object.keys(VENDOR_CAPABILITIES).sort()).toEqual(expected)
    expect(Object.keys(MODE_CATALOGS).sort()).toEqual(expected)
    expect(Object.keys(HOST_BINARIES).sort()).toEqual(expected)
    expect(Object.keys(VENDOR_AUTH_PROFILES).sort()).toEqual(expected)
    expect(Object.keys(VENDOR_AGENT_SCHEMAS).sort()).toEqual(expected)
  })
})

describe('cursor-specific registration facts', () => {
  it('cursor is an externally installed CLI (not npm-managed)', () => {
    const spec = HOST_BINARIES.cursor
    expect(spec.kind).toBe('external')
    if (spec.kind === 'external') {
      expect(spec.isCompatibleVersion('2026.07.23-e383d2b')).toBe(true)
      expect(spec.isCompatibleVersion('2020.01.01')).toBe(false)
    }
  })

  it('cursor declares no per-tool approval, in-process MCP, task store, or native user input', () => {
    const caps = VENDOR_CAPABILITIES.cursor
    expect(caps.perToolApproval).toBe(false)
    expect(caps.inProcessMcp).toBe(false)
    expect(caps.taskStore).toBe(false)
    expect(caps.nativeUserInput).toBe(false)
    // Resume is native and proven; list/read are only the c3 mirror.
    expect(caps.sessions.resume).toBe('full')
    expect(caps.sessions.list).toBe('partial')
    expect(caps.sessions.read).toBe('partial')
  })

  it('cursor offers no plan mode (refused, never silently writable)', () => {
    const tokens = MODE_CATALOGS.cursor.modes.map((m) => m.token)
    expect(tokens).not.toContain('plan')
    expect(MODE_CATALOGS.cursor.modes.every((m) => m.actionMode === 'build')).toBe(true)
  })

  it('cursor store dir is its own data root, not Claude’s', () => {
    const cursorDir = resolveVendorStoreDir('cursor', '/ws', 'host')
    expect(cursorDir).toBe(hostCursorHome())
    expect(cursorDir).not.toBe(hostClaudeConfigDir())
  })

  it('the agent-config schema accepts a system cursor agent and rejects a custom one', () => {
    const ok = agentConfigSchema.safeParse({
      id: 'a',
      vendor: 'cursor',
      configMode: 'system',
      displayName: 'Cursor',
      config: {},
    })
    expect(ok.success).toBe(true)
    // An empty config is the only legal shape — a provider triple is rejected.
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
