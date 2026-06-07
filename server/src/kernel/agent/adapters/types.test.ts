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
import { createClaudeAdapter } from './claude/index.js'
import { createCodexAdapter } from './codex/index.js'

/** The seven boolean live-run capability flags — the complete, closed set. */
const BOOLEAN_CAPABILITY_KEYS = [
  'interrupt',
  'setActionMode',
  'streamingPush',
  'inProcessMcp',
  'forkSession',
  'perToolApproval',
  'taskStore',
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

  // The ledger carries EXACTLY the seven boolean flags plus the `sessions` sub-ledger.
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

  it('Codex reports list/read = none, yet resume = full (a boolean could not say this)', () => {
    const { capabilities } = createCodexAdapter()
    // The SDK has no listing/reading API — honest `none`, not a faked empty.
    expect(capabilities.sessions.list).toBe('none')
    expect(capabilities.sessions.read).toBe('none')
    // …but a known thread still resumes end-to-end (`resumeThread`). The exact
    // pair structured states exist to express; a single boolean would erase it.
    expect(capabilities.sessions.resume).toBe('full')
    expect(capabilities.sessions.rename).toBe('none')
    expect(capabilities.sessions.delete).toBe('none')
  })
})
