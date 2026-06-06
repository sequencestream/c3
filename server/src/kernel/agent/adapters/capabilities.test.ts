/**
 * Static capability ledger + the agent-team gate (2026-06-06-006).
 *
 * Pins the heterogeneous-tolerance invariant: agent-teams are **Claude-locked**
 * via the `streamingPush` capability. The lead must stay resident across turns and
 * run in-process TeamCreate/SendMessage; only Claude can. So `canFormTeam` is true
 * for Claude and false for every non-Claude vendor — and it must track the ledger
 * exactly (no hard-coded vendor list that could drift from the real capability).
 */
import { describe, it, expect } from 'vitest'
import { VENDOR_CAPABILITIES, canFormTeam } from './capabilities.js'

describe('canFormTeam — agent-teams are Claude-locked (streamingPush)', () => {
  it('is true only for Claude', () => {
    expect(canFormTeam('claude')).toBe(true)
    expect(canFormTeam('opencode')).toBe(false)
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
    // The map is total over the implemented vendors, so the gate never throws on a
    // resolvable vendor.
    expect(Object.keys(VENDOR_CAPABILITIES).sort()).toEqual(['claude', 'codex', 'opencode'])
  })
})
