/**
 * Vendor-agnostic interface contract (ADR-0011). {@link assertNeutralAdapterShape}
 * is the gate EVERY vendor adapter must pass: it pins the required three-piece
 * surface (always present, no capability flag) and the optional/degradable
 * capability ledger (exactly six boolean flags), keeping the "required vs
 * optional" line mechanically enforced. It is exercised here against the Claude
 * reference adapter and re-used by each future vendor's test.
 */
import { describe, it, expect } from 'vitest'
import type { VendorAdapter } from './types.js'
import { createClaudeAdapter } from './claude/index.js'
import { createCodexAdapter } from './codex/index.js'

/** The six optional/degradable capability flags — the complete, closed set. */
const OPTIONAL_CAPABILITY_KEYS = [
  'interrupt',
  'setActionMode',
  'streamingPush',
  'inProcessMcp',
  'forkSession',
  'perToolApproval',
] as const

/** Required surface that exists unconditionally — NOT gated by any flag. */
export function assertNeutralAdapterShape(adapter: VendorAdapter): void {
  // Vendor identity + capability ledger are present.
  expect(typeof adapter.vendor).toBe('string')
  expect(adapter.capabilities).toBeTruthy()

  // The capability ledger carries EXACTLY the six optional flags, all boolean —
  // required capabilities (start / messages / approval / read) have NO flag here.
  expect(Object.keys(adapter.capabilities).sort()).toEqual([...OPTIONAL_CAPABILITY_KEYS].sort())
  for (const key of OPTIONAL_CAPABILITY_KEYS) {
    expect(typeof adapter.capabilities[key]).toBe('boolean')
  }
  // No required capability leaked in as a flag.
  expect('start' in adapter.capabilities).toBe(false)
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
}

describe('neutral adapter contract', () => {
  it('Claude reference adapter satisfies the required surface + capability ledger', () => {
    assertNeutralAdapterShape(createClaudeAdapter())
  })

  it('Codex adapter satisfies the same required surface (no per-tool approval)', () => {
    assertNeutralAdapterShape(createCodexAdapter())
  })

  it('distinguishes required (unflagged) from optional (flagged) capabilities', () => {
    const { capabilities } = createClaudeAdapter()
    // Exactly six optional flags — the closed degradable set.
    expect(Object.keys(capabilities)).toHaveLength(OPTIONAL_CAPABILITY_KEYS.length)
    // perToolApproval is the D2 addition beyond the original five — present & boolean.
    expect('perToolApproval' in capabilities).toBe(true)
  })

  it('Codex capability ledger is all-false, faithful to Phase 0 (008 NO-GO)', () => {
    const { capabilities } = createCodexAdapter()
    // Every flag false — Codex is the read-only advisor seat; the load-bearing
    // one is perToolApproval: false (no in-the-loop approval point exists).
    for (const key of OPTIONAL_CAPABILITY_KEYS) {
      expect(capabilities[key]).toBe(false)
    }
  })
})
