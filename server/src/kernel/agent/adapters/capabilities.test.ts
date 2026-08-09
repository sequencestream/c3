/**
 * Static capability ledger + the agent-team gate (2026-06-06-006).
 *
 * Pins the heterogeneous-tolerance invariant: agent-teams are **Claude-locked**
 * via the `streamingPush` capability. The lead must stay resident across turns and
 * run in-process TeamCreate/SendMessage; only Claude can. So `canFormTeam` is true
 * for Claude and false for every non-Claude vendor — and it must track the ledger
 * exactly (no hard-coded vendor list that could drift from the real capability).
 */
import { VENDOR_IDS } from '@ccc/shared/protocol'
import { describe, it, expect } from 'vitest'
import type { CapabilityState, SessionCapabilities, VendorId } from '@ccc/shared/protocol'
import { VENDOR_CAPABILITIES, canDeleteSession, canFormTeam } from './capabilities.js'

describe('canFormTeam — agent-teams are Claude-locked (streamingPush)', () => {
  it('is true only for Claude', () => {
    expect(canFormTeam('claude')).toBe(true)
    expect(canFormTeam('codex')).toBe(false)
  })

  it('tracks the streamingPush capability exactly (not a hard-coded vendor list)', () => {
    for (const vendor of Object.keys(VENDOR_CAPABILITIES) as Array<
      keyof typeof VENDOR_CAPABILITIES
    >) {
      expect(canFormTeam(vendor)).toBe(VENDOR_CAPABILITIES[vendor].streamingPush)
    }
  })

  it('covers every vendor that has a capability ledger', () => {
    // Total over the authoritative vendor list, so the gate never throws on a
    // resolvable vendor. Derived from VENDOR_IDS rather than a literal list: a new
    // vendor without a ledger fails here instead of silently reporting no abilities.
    expect(Object.keys(VENDOR_CAPABILITIES).sort()).toEqual([...VENDOR_IDS].sort())
  })
})

describe('canDeleteSession — transcript deletion follows the session ledger', () => {
  it('is true only for the vendors whose store can delete', () => {
    expect(canDeleteSession('claude')).toBe(true)
    // Codex exposes no delete op — its transcript outlives c3's references.
    expect(canDeleteSession('codex')).toBe(false)
  })

  it('tracks the sessions.delete state exactly (not a hard-coded vendor list)', () => {
    for (const vendor of Object.keys(VENDOR_CAPABILITIES) as VendorId[]) {
      expect(canDeleteSession(vendor)).toBe(VENDOR_CAPABILITIES[vendor].sessions.delete !== 'none')
    }
  })
})

/**
 * The structured session-capability matrix (ADR-0011 amendment). Each vendor
 * self-reports a {@link CapabilityState} per session-lifecycle op; this pins the
 * honest matrix so a regression that flattens a state fails loud.
 */
const STATES: readonly CapabilityState[] = ['none', 'partial', 'full', 'temporarily-unavailable']
const OPS = ['list', 'read', 'resume', 'rename', 'delete'] as const

/** The authoritative honest matrix — the table in the ADR-0011 amendment. */
const EXPECTED: Partial<Record<VendorId, SessionCapabilities>> = {
  claude: { list: 'full', read: 'full', resume: 'full', rename: 'full', delete: 'full' },
  codex: { list: 'full', read: 'full', resume: 'full', rename: 'none', delete: 'none' },
  // Cursor resumes by an id it minted itself, and list/read read its own on-disk
  // chat store — the same one the IDE writes, so the whole history is visible.
  cursor: { list: 'full', read: 'full', resume: 'full', rename: 'none', delete: 'none' },
}

describe('structured session-capability ledger', () => {
  it('every vendor self-reports all five ops with a legal 4-state value', () => {
    for (const vendor of Object.keys(VENDOR_CAPABILITIES) as VendorId[]) {
      const { sessions } = VENDOR_CAPABILITIES[vendor]
      expect(Object.keys(sessions).sort()).toEqual([...OPS].sort())
      for (const op of OPS) expect(STATES).toContain(sessions[op])
    }
  })

  it('matches the honest per-vendor matrix', () => {
    for (const vendor of Object.keys(EXPECTED) as VendorId[]) {
      expect(VENDOR_CAPABILITIES[vendor].sessions).toEqual(EXPECTED[vendor])
    }
  })

  it('exercises multiple states across the matrix (a boolean could not)', () => {
    const reported = new Set<CapabilityState>()
    for (const vendor of Object.keys(VENDOR_CAPABILITIES) as VendorId[]) {
      for (const op of OPS) reported.add(VENDOR_CAPABILITIES[vendor].sessions[op])
    }
    // none (Codex) and full (Claude) both live.
    expect(reported.has('none')).toBe(true)
    expect(reported.has('full')).toBe(true)
  })
})
