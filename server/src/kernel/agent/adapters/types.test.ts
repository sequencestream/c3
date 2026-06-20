/**
 * Vendor-agnostic interface contract (ADR-0011). {@link assertNeutralAdapterShape}
 * is the gate EVERY vendor adapter must pass: it pins the required three-piece
 * surface (always present, no capability flag), the six boolean live-run flags,
 * and the structured `sessions` sub-ledger (ADR-0011 amendment: a 4-state
 * {@link CapabilityState} per session-lifecycle op), keeping the contract
 * mechanically enforced. It is exercised here against the Claude reference adapter
 * and re-used by each future vendor's test.
 */
import { describe, it, expect } from 'vitest'
import type { CapabilityState, VendorAdapter } from './types.js'
// import type { ToolManifestEntry } from '@ccc/shared/protocol'
import { createClaudeAdapter } from './claude/index.js'
import { createCodexAdapter } from './codex/index.js'

/** The eight boolean live-run capability flags — the complete, closed set. */
const BOOLEAN_CAPABILITY_KEYS = [
  'interrupt',
  'setActionMode',
  'streamingPush',
  'inProcessMcp',
  'forkSession',
  'perToolApproval',
  'taskStore',
  'nativeUserInput',
] as const

/** The five structured session-lifecycle operations — the complete, closed set. */
const SESSION_CAPABILITY_KEYS = ['list', 'read', 'resume', 'rename', 'delete'] as const

/** The four legal capability states — every `sessions` value must be one of these. */
const CAPABILITY_STATES: readonly CapabilityState[] = [
  'none',
  'partial',
  'full',
  'temporarily-unavailable',
]

/** Required surface that exists unconditionally — NOT gated by any flag. */
export function assertNeutralAdapterShape(adapter: VendorAdapter): void {
  // Vendor identity + capability ledger are present.
  expect(typeof adapter.vendor).toBe('string')
  expect(adapter.capabilities).toBeTruthy()

  // The ledger carries EXACTLY the eight boolean flags plus the `sessions` sub-ledger.
  expect(Object.keys(adapter.capabilities).sort()).toEqual(
    [...BOOLEAN_CAPABILITY_KEYS, 'sessions'].sort(),
  )
  for (const key of BOOLEAN_CAPABILITY_KEYS) {
    expect(typeof adapter.capabilities[key]).toBe('boolean')
  }
  // The structured sub-ledger: exactly the five ops, each a legal 4-state value.
  expect(Object.keys(adapter.capabilities.sessions).sort()).toEqual(
    [...SESSION_CAPABILITY_KEYS].sort(),
  )
  for (const key of SESSION_CAPABILITY_KEYS) {
    expect(CAPABILITY_STATES).toContain(adapter.capabilities.sessions[key])
  }
  // Required contract methods are NOT flags (they exist unconditionally).
  expect('start' in adapter.capabilities).toBe(false)
  // `read` is now a structured state under `sessions`, never a top-level flag.
  expect('read' in adapter.capabilities).toBe(false)

  // Required AgentDriver surface.
  expect(adapter.driver.vendor).toBe(adapter.vendor)
  expect(adapter.driver.capabilities).toBe(adapter.capabilities)
  expect(typeof adapter.driver.start).toBe('function')

  // Required ApprovalBridge surface (onRequest returns a disposer).
  expect(typeof adapter.approval.onRequest).toBe('function')
  const dispose = adapter.approval.onRequest(async () => ({ behavior: 'deny', reason: 'test' }))
  expect(typeof dispose).toBe('function')
  dispose()

  // Required SessionStore surface.
  expect(typeof adapter.sessions.list).toBe('function')
  expect(typeof adapter.sessions.read).toBe('function')

  // Required SkillLoader surface (mount layer 2/3): three methods, vendor-tagged.
  expect(adapter.skill.vendor).toBe(adapter.vendor)
  expect(typeof adapter.skill.getVendorSkillDir).toBe('function')
  expect(typeof adapter.skill.detectSkillSupport).toBe('function')
  expect(typeof adapter.skill.ensureLink).toBe('function')

  // Required listTools surface — every adapter exposes a static tool lister.
  expect(typeof adapter.listTools).toBe('function')
  // Returns a non-empty array without throwing, even without MCP config.
  const tools = adapter.listTools('/tmp')
  expect(Array.isArray(tools)).toBe(true)
  expect(tools.length).toBeGreaterThan(0)
  for (const t of tools) {
    expect(typeof t.name).toBe('string')
    expect(typeof t.isWrite).toBe('boolean')
  }
}

describe('neutral adapter contract', () => {
  it('Claude reference adapter satisfies the required surface + capability ledger', () => {
    assertNeutralAdapterShape(createClaudeAdapter())
  })

  it('Codex adapter satisfies the same required surface (no per-tool approval)', () => {
    assertNeutralAdapterShape(createCodexAdapter())
  })

  it('distinguishes the boolean flags from the structured sessions sub-ledger', () => {
    const { capabilities } = createClaudeAdapter()
    // Seven boolean flags + one `sessions` sub-ledger = eight keys, the closed set.
    expect(Object.keys(capabilities)).toHaveLength(BOOLEAN_CAPABILITY_KEYS.length + 1)
    // perToolApproval is the D2 addition beyond the original five — present & boolean.
    expect('perToolApproval' in capabilities).toBe(true)
    // The reference adapter reports every session-lifecycle op as `full`.
    for (const key of SESSION_CAPABILITY_KEYS) {
      expect(capabilities.sessions[key]).toBe('full')
    }
  })

  it('Codex capability ledger is all-false (except taskStore), faithful to Phase 0 (008 NO-GO)', () => {
    const { capabilities } = createCodexAdapter()
    // Every boolean flag false except taskStore — the SDK task tools work
    // even without per-tool approval (orthogonal to 008). All other flags are
    // false: Codex is the read-only advisor seat; the load-bearing one is
    // perToolApproval: false (no in-the-loop approval point).
    for (const key of BOOLEAN_CAPABILITY_KEYS) {
      if (key === 'taskStore') {
        expect(capabilities[key]).toBe(true)
      } else {
        expect(capabilities[key]).toBe(false)
      }
    }
  })

  it('Codex reports list/read = full (on-disk JSONL), resume = full', () => {
    const { capabilities } = createCodexAdapter()
    // Codex now enumerates and back-reads via on-disk JSONL.
    expect(capabilities.sessions.list).toBe('full')
    expect(capabilities.sessions.read).toBe('full')
    // A known thread still resumes end-to-end (`resumeThread`).
    expect(capabilities.sessions.resume).toBe('full')
    expect(capabilities.sessions.rename).toBe('none')
    expect(capabilities.sessions.delete).toBe('none')
  })

  // -----------------------------------------------------------------------
  // listTools
  // -----------------------------------------------------------------------

  it('Claude listTools returns SDK read/write tools correctly classified', () => {
    const adapter = createClaudeAdapter()
    const tools = adapter.listTools('/tmp')

    // Every SDK read tool is classified isWrite=false
    for (const t of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']) {
      const entry = tools.find((e) => e.name === t)
      expect(entry, `missing read tool: ${t}`).toBeTruthy()
      expect(entry!.isWrite).toBe(false)
    }

    // Every SDK write tool is classified isWrite=true
    for (const t of ['Write', 'Edit', 'Bash', 'Agent']) {
      const entry = tools.find((e) => e.name === t)
      expect(entry, `missing write tool: ${t}`).toBeTruthy()
      expect(entry!.isWrite).toBe(true)
    }
  })

  it('Claude listTools includes MCP namespace prefixes when mcpServers provided', () => {
    const adapter = createClaudeAdapter()
    const mcpServers = {
      c3: { command: 'node', args: ['server.mjs'] },
      pg: { command: 'npx', args: ['@mcp/pg'] },
    }
    const tools = adapter.listTools('/tmp', mcpServers)

    // MCP namespace prefixes present
    expect(tools.find((e) => e.name === 'mcp__c3__')).toBeTruthy()
    expect(tools.find((e) => e.name === 'mcp__pg__')).toBeTruthy()

    // MCP namespaces are classified as write (conservative)
    const c3Ns = tools.find((e) => e.name === 'mcp__c3__')!
    expect(c3Ns.isWrite).toBe(true)

    // SDK tools still present
    expect(tools.find((e) => e.name === 'Read')).toBeTruthy()
  })

  it('Claude listTools works without MCP servers (no crash)', () => {
    const adapter = createClaudeAdapter()
    const tools = adapter.listTools('/tmp')
    // No MCP entries when no servers configured
    expect(tools.filter((e) => e.name.startsWith('mcp__'))).toHaveLength(0)
  })

  it('Codex listTools returns codex tools without MCP namespace prefixes', () => {
    const adapter = createCodexAdapter()
    const mcpServers = { c3: { command: 'node', args: ['server.mjs'] } }
    const tools = adapter.listTools('/tmp', mcpServers)

    // Codex SDK tools present — these are the real tool names from translate.ts
    expect(tools.find((e) => e.name === 'web_search')).toBeTruthy()
    expect(tools.find((e) => e.name === 'shell')).toBeTruthy()
    expect(tools.find((e) => e.name === 'apply_patch')).toBeTruthy()

    // Claude-specific tools must NOT appear
    expect(tools.find((e) => e.name === 'Read')).toBeFalsy()
    expect(tools.find((e) => e.name === 'Write')).toBeFalsy()
    expect(tools.find((e) => e.name === 'Bash')).toBeFalsy()

    // MCP namespace prefixes present when mcpServers passed
    expect(tools.find((e) => e.name === 'mcp__c3__')).toBeTruthy()
  })

  it('Codex listTools correctly classifies read vs write', () => {
    const adapter = createCodexAdapter()
    const tools = adapter.listTools('/tmp')

    // Codex read tools
    expect(tools.find((e) => e.name === 'web_search')!.isWrite).toBe(false)
    expect(tools.find((e) => e.name === 'TaskCreate')!.isWrite).toBe(false)
    expect(tools.find((e) => e.name === 'TaskList')!.isWrite).toBe(false)
    expect(tools.find((e) => e.name === 'TaskUpdate')!.isWrite).toBe(false)
    expect(tools.find((e) => e.name === 'TaskGet')!.isWrite).toBe(false)

    // Codex write tools
    expect(tools.find((e) => e.name === 'shell')!.isWrite).toBe(true)
    expect(tools.find((e) => e.name === 'apply_patch')!.isWrite).toBe(true)
  })
})
