/**
 * The externally-grantable catalog's SHAPE — what an administrator can ever tick,
 * and what a fresh key starts with.
 *
 * These two are deliberately different questions, and this file is where the
 * difference is pinned: the delivery read tools are grantable but NOT default, so
 * a new key cannot silently gain the ability to read a workspace's delivery plan.
 */
import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_MCP_DEFAULT_TOOLS,
  EXTERNAL_MCP_READ_TOOLS,
  EXTERNAL_MCP_WRITE_TOOLS,
} from '@ccc/shared/protocol'
import {
  externalMcpToolDescriptors,
  isExternalMcpToolName,
  normalizeExternalMcpToolScope,
} from './tools.js'

const names = (): string[] => externalMcpToolDescriptors().map((d) => d.name)

describe('external MCP catalog', () => {
  it('offers the two delivery tools, graded read', () => {
    const descriptors = externalMcpToolDescriptors()
    expect(descriptors).toEqual(
      expect.arrayContaining([
        { name: 'find_deliveries', access: 'read' },
        { name: 'view_delivery', access: 'read' },
      ]),
    )
  })

  it('offers no delivery WRITE tool — a status write funnels through the state machine', () => {
    expect(names().filter((n) => n.includes('deliver') || n.includes('delivery'))).toEqual([
      'find_deliveries',
      'view_delivery',
    ])
    expect(EXTERNAL_MCP_WRITE_TOOLS.some((n) => n.includes('deliver'))).toBe(false)
  })

  it('refuses a scope naming a tool outside the catalog', () => {
    expect(isExternalMcpToolName('reconcile_intent_pr')).toBe(false)
    // A scope with one unknown name fails as a WHOLE, so a stale authorization can
    // never be half-applied.
    expect(normalizeExternalMcpToolScope(['find_intents', 'reconcile_intent_pr'])).toEqual({
      ok: false,
      offender: 'reconcile_intent_pr',
    })
  })
})

describe('the two discovery tools', () => {
  it('are graded read — they answer about scope, they never change it', () => {
    expect(externalMcpToolDescriptors()).toEqual(
      expect.arrayContaining([
        { name: 'list_workspaces', access: 'read' },
        { name: 'whoami', access: 'read' },
      ]),
    )
  })

  it('ARE in the default set — a key that cannot see its own reach has to guess it', () => {
    const defaults = [...EXTERNAL_MCP_DEFAULT_TOOLS] as string[]
    expect(defaults).toContain('list_workspaces')
    expect(defaults).toContain('whoami')
  })
})

describe('the default scope of a new key', () => {
  it('is NARROWER than the read-graded catalog — grantable is not granted', () => {
    const defaults = [...EXTERNAL_MCP_DEFAULT_TOOLS] as string[]
    const reads = [...EXTERNAL_MCP_READ_TOOLS] as string[]
    expect(defaults.every((n) => reads.includes(n))).toBe(true)
    expect(defaults.length).toBeLessThan(reads.length)
  })

  it('does NOT include the delivery read tools', () => {
    const defaults = [...EXTERNAL_MCP_DEFAULT_TOOLS] as string[]
    expect(defaults).not.toContain('find_deliveries')
    expect(defaults).not.toContain('view_delivery')
  })

  it('contains no write tool', () => {
    const writes = [...EXTERNAL_MCP_WRITE_TOOLS] as string[]
    for (const name of EXTERNAL_MCP_DEFAULT_TOOLS) expect(writes).not.toContain(name)
  })

  it('leaves both delivery tools grantable by an explicit tick', () => {
    expect(
      normalizeExternalMcpToolScope(['find_intents', 'find_deliveries', 'view_delivery']),
    ).toMatchObject({ ok: true })
  })
})
