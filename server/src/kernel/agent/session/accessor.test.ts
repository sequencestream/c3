/**
 * c3 session namespace + read-only lazy normalization coverage (ADR-0013).
 *
 * Proven with fake {@link SessionStore}s — no real JSONL/REST. Invariants:
 *  - the minted c3 id is deterministic and contains NEITHER the vendor name nor
 *    the raw vendor id as a substring (safe for URL/storage);
 *  - `list` merges across vendors and hands back c3 ids, hiding vendor ids in
 *    `vendorExtra`;
 *  - `read` routes to the owning vendor's store, lazily resolving on an index miss.
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionAccessor, mintC3SessionId } from './accessor.js'
import type { VendorSessionSource } from './accessor.js'
import type { CanonicalMessage, SessionStore, SessionSummary } from '../adapters/types.js'

function fakeStore(
  summaries: SessionSummary[],
  reads: Record<string, CanonicalMessage[]> = {},
): SessionStore {
  return {
    list: vi.fn(async () => summaries),
    read: vi.fn(async (id: string) => reads[id] ?? []),
  }
}

const cwd = { cwd: '/ws' }

describe('mintC3SessionId', () => {
  it('is deterministic for the same ref', () => {
    const a = mintC3SessionId({ vendor: 'claude', vendorSessionId: 'abc' })
    const b = mintC3SessionId({ vendor: 'claude', vendorSessionId: 'abc' })
    expect(a).toBe(b)
  })

  it('contains neither the vendor name nor the raw vendor id as a substring', () => {
    const id = mintC3SessionId({ vendor: 'claude', vendorSessionId: 'session-xyz' })
    expect(id).not.toContain('claude')
    expect(id).not.toContain('session-xyz')
  })

  it('does not collide across the vendor/id boundary', () => {
    const a = mintC3SessionId({ vendor: 'codex', vendorSessionId: 'a-bc' })
    const b = mintC3SessionId({ vendor: 'codex', vendorSessionId: 'ab-c' })
    expect(a).not.toBe(b)
  })
})

describe('SessionAccessor', () => {
  const sources = (): VendorSessionSource[] => [
    { vendor: 'claude', sessions: fakeStore([{ sessionId: 'c-1', title: 'Claude one' }]) },
    { vendor: 'codex', sessions: fakeStore([{ sessionId: 'x-1', title: 'Codex one' }]) },
  ]

  it('merges listings across vendors and exposes c3 ids, hiding vendor ids in vendorExtra', async () => {
    const acc = new SessionAccessor(sources())
    const list = await acc.list(cwd)
    expect(list).toHaveLength(2)
    for (const s of list) {
      expect(s.c3SessionId.startsWith('c3s_')).toBe(true)
      // The native vendor id is tucked into vendorExtra, never the top level.
      expect(s.vendorExtra?.vendorSessionId).toBeDefined()
    }
    expect(list.map((s) => s.title).sort()).toEqual(['Claude one', 'Codex one'])
    // The vendor *tag* is stamped top-level (a display dimension), tracking the
    // owning store — distinct from the native id, which stays in vendorExtra.
    const byTitle = Object.fromEntries(list.map((s) => [s.title, s]))
    expect(byTitle['Claude one'].vendor).toBe('claude')
    expect(byTitle['Codex one'].vendor).toBe('codex')
    expect(byTitle['Claude one'].vendorExtra?.vendorSessionId).toBe('c-1')
  })

  it('routes read to the owning vendor store after a list', async () => {
    const claudeMsg: CanonicalMessage = {
      vendor: 'claude',
      sessionId: 'c-1',
      role: 'assistant',
      ts: 1,
      blocks: [{ type: 'text', text: 'history' }],
    }
    const srcs: VendorSessionSource[] = [
      {
        vendor: 'claude',
        sessions: fakeStore([{ sessionId: 'c-1', title: 'Claude one' }], { 'c-1': [claudeMsg] }),
      },
      { vendor: 'codex', sessions: fakeStore([{ sessionId: 'x-1', title: 'Codex one' }]) },
    ]
    const acc = new SessionAccessor(srcs)
    const c3 = mintC3SessionId({ vendor: 'claude', vendorSessionId: 'c-1' })
    const history = await acc.read(c3, cwd)
    expect(history).toEqual([claudeMsg])
    // It hit the claude store with the NATIVE id, not the c3 id.
    expect(srcs[0].sessions.read).toHaveBeenCalledWith('c-1', cwd)
    expect(srcs[1].sessions.read).not.toHaveBeenCalled()
  })

  it('lazily resolves on an index miss (read without a prior list still works)', async () => {
    const srcs = sources()
    const acc = new SessionAccessor(srcs)
    const c3 = mintC3SessionId({ vendor: 'codex', vendorSessionId: 'x-1' })
    // No list() called yet — read must lazily list to fill the index, then route.
    await acc.read(c3, cwd)
    expect(srcs[1].sessions.list).toHaveBeenCalled()
    expect(srcs[1].sessions.read).toHaveBeenCalledWith('x-1', cwd)
  })

  it('returns [] for a c3 id no vendor owns', async () => {
    const acc = new SessionAccessor(sources())
    const orphan = mintC3SessionId({ vendor: 'opencode', vendorSessionId: 'nope' })
    expect(await acc.read(orphan, cwd)).toEqual([])
  })
})
