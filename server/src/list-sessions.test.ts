/**
 * Coverage for the cross-vendor `list_sessions` swap (ADR-0013, `list-sessions.ts`).
 *
 * Two invariants:
 *  1. **Zero-regression for claude.** Listing a claude-only `SessionAccessor`
 *     (whose source is the real `ClaudeSessionStore` → `listWorkspaceSessions`)
 *     must produce the SAME `SessionInfo[]` as calling `listWorkspaceSessions`
 *     directly — field-for-field, modulo the new `vendor: 'claude'` tag. The SDK
 *     `listSessions` is mocked (as in `sessions-hidden/tool.test.ts`) so the test
 *     exercises only the c3 normalization layer.
 *  2. **Cross-vendor merge.** With a claude + opencode source pair (fake stores),
 *     the entries merge, normalize per-vendor (opencode has no c3 mode / tool tag,
 *     its `time` becomes `lastModified`), and sort newest-first globally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { listSessionsMock } = vi.hoisted(() => ({ listSessionsMock: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, listSessions: listSessionsMock }
})

import { resetDbForTests } from './kernel/infra/db.js'
import { resetStoreForTests } from './features/requirements/store.js'
import { listWorkspaceSessions } from './sessions.js'
import { ClaudeSessionStore } from './kernel/agent/adapters/claude/session-store.js'
import { SessionAccessor, type VendorSessionSource } from './kernel/agent/session/accessor.js'
import { listSessionsVia } from './kernel/agent/session/list-sessions.js'
import type { SessionStore, SessionSummary } from './kernel/agent/adapters/types.js'

const proj = '/abs/list-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-list-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  listSessionsMock.mockReset()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

const sdkSessions = [
  { sessionId: 'normal-1', firstPrompt: 'hello', lastModified: 100 },
  { sessionId: 'normal-2', firstPrompt: 'world', lastModified: 300 },
  { sessionId: 'normal-3', customTitle: 'Pinned', lastModified: 200 },
]

/** A minimal read-only fake store (mirrors accessor.test.ts) for the merge case. */
function fakeStore(summaries: SessionSummary[]): SessionStore {
  return { list: vi.fn(async () => summaries), read: vi.fn(async () => []) }
}

describe('listSessionsVia — zero-regression vs listWorkspaceSessions (claude only)', () => {
  it('reproduces the legacy output field-for-field (both carry vendor:claude)', async () => {
    listSessionsMock.mockResolvedValue(sdkSessions)

    const legacy = await listWorkspaceSessions(proj)
    const accessor = new SessionAccessor([{ vendor: 'claude', sessions: new ClaudeSessionStore() }])
    const swapped = await listSessionsVia(accessor, proj)

    // The swapped path is byte-identical to the legacy claude-only path (the
    // legacy path now also stamps vendor:'claude', required on the wire).
    expect(swapped).toEqual(legacy)
    expect(swapped.every((s) => s.vendor === 'claude')).toBe(true)
    // Sanity: newest-first, native ids preserved on the wire.
    expect(swapped.map((s) => s.sessionId)).toEqual(['normal-2', 'normal-3', 'normal-1'])
  })
})

describe('listSessionsVia — cross-vendor merge (claude + opencode)', () => {
  it('merges, normalizes per vendor, and sorts newest-first globally', async () => {
    const claudeSrc: VendorSessionSource = {
      vendor: 'claude',
      sessions: fakeStore([
        {
          sessionId: 'c-old',
          title: 'Claude old',
          vendorExtra: { lastModified: 100, mode: 'plan', isToolSession: true },
        },
        {
          sessionId: 'c-new',
          title: 'Claude new',
          vendorExtra: { lastModified: 400, mode: 'default', isToolSession: false },
        },
      ]),
    }
    const opencodeSrc: VendorSessionSource = {
      vendor: 'opencode',
      sessions: fakeStore([
        {
          sessionId: 'o-1',
          title: 'OpenCode one',
          // OpenCode carries `time = { created, updated? }`; updated wins as the key.
          vendorExtra: { time: { created: 200, updated: 300 } },
        },
      ]),
    }
    const accessor = new SessionAccessor([claudeSrc, opencodeSrc])
    const out = await listSessionsVia(accessor, '/ws')

    // Global newest-first: c-new(400) > o-1(300) > c-old(100).
    expect(out.map((s) => s.sessionId)).toEqual(['c-new', 'o-1', 'c-old'])
    const byId = Object.fromEntries(out.map((s) => [s.sessionId, s]))

    // Claude entries pass mode / isToolSession through unchanged.
    expect(byId['c-old']).toMatchObject({
      vendor: 'claude',
      mode: 'plan',
      isToolSession: true,
      lastModified: 100,
    })
    // OpenCode has no c3 mode / tool tag ⇒ defaults; `time.updated` is the sort key.
    expect(byId['o-1']).toMatchObject({
      vendor: 'opencode',
      mode: 'default',
      isToolSession: false,
      lastModified: 300,
      title: 'OpenCode one',
    })
  })

  it('skips a vendor whose store fails to list (loud-but-non-fatal), keeping the rest', async () => {
    const claudeSrc: VendorSessionSource = {
      vendor: 'claude',
      sessions: fakeStore([
        {
          sessionId: 'c-1',
          title: 'Claude one',
          vendorExtra: { lastModified: 50, mode: 'default', isToolSession: false },
        },
      ]),
    }
    const brokenOpencode: VendorSessionSource = {
      vendor: 'opencode',
      sessions: {
        list: vi.fn(async () => {
          throw new Error('opencode server down')
        }),
        read: vi.fn(async () => []),
      },
    }
    const accessor = new SessionAccessor([claudeSrc, brokenOpencode])
    const out = await listSessionsVia(accessor, '/ws')
    expect(out.map((s) => s.sessionId)).toEqual(['c-1'])
  })
})
