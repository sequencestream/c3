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
 *  2. **Cross-vendor merge.** With a claude + codex source pair (fake stores),
 *     the entries merge, normalize per-vendor, and sort newest-first globally.
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
import { insertIntents, resetStoreForTests, setSpecSessionId } from './features/intents/store.js'
import { recordToolSession } from './features/intents/store.js'
import {
  resetStoreForTests as resetSessionsStoreForTests,
  upsertBoundRow,
} from './features/works/work-session-store.js'
import { resetSettingsCacheForTests, saveSettings } from './kernel/config/index.js'
import { listWorkspaceSessions } from './sessions.js'
import { ClaudeSessionStore } from './kernel/agent/adapters/claude/session-store.js'
import { SessionAccessor, type VendorSessionSource } from './kernel/agent/session/accessor.js'
import { listSessionsVia } from './kernel/agent/session/list-sessions.js'
import type { SessionStore, SessionSummary } from './kernel/agent/adapters/types.js'

const proj = '/abs/list-proj'
let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-list-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetSessionsStoreForTests()
  resetSettingsCacheForTests()
  listSessionsMock.mockReset()
})

afterEach(() => {
  resetDbForTests()
  resetSettingsCacheForTests()
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
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
  it('reproduces the legacy output field-for-field (modulo the additive `state` field)', async () => {
    listSessionsMock.mockResolvedValue(sdkSessions)

    const legacy = await listWorkspaceSessions(proj)
    const accessor = new SessionAccessor([{ vendor: 'claude', sessions: new ClaudeSessionStore() }])
    const swapped = await listSessionsVia(accessor, proj)

    // The swapped path is the legacy claude-only path's output plus the new
    // additive `state` field (ADR-0013 amendment — projection table contract).
    // The wire shape is otherwise identical: same sessionId, title, mode
    // (from state.ts), isToolSession (from the tool-session table), and
    // newest-first ordering.
    const legacyComparable = legacy.map((s) => ({ ...s, state: undefined }))
    const swappedComparable = swapped.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      lastModified: s.lastModified,
      mode: s.mode,
      isToolSession: s.isToolSession,
      vendor: s.vendor,
      state: undefined,
    }))
    expect(swappedComparable).toEqual(legacyComparable)
    expect(swapped.every((s) => s.vendor === 'claude')).toBe(true)
    expect(swapped.every((s) => s.state === 'alive')).toBe(true)
    // Sanity: newest-first, native ids preserved on the wire.
    expect(swapped.map((s) => s.sessionId)).toEqual(['normal-2', 'normal-3', 'normal-1'])
  })
})

describe('listSessionsVia — cross-vendor merge (claude + codex)', () => {
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
    const codexSrc: VendorSessionSource = {
      vendor: 'codex',
      sessions: fakeStore([
        {
          sessionId: 'cx-1',
          title: 'Codex one',
          vendorExtra: { time: { created: 200, updated: 300 } },
        },
      ]),
    }
    const accessor = new SessionAccessor([claudeSrc, codexSrc])
    const out = await listSessionsVia(accessor, '/ws')

    // Global newest-first: c-new(400) > cx-1(300) > c-old(100).
    expect(out.map((s) => s.sessionId)).toEqual(['c-new', 'cx-1', 'c-old'])
    const byId = Object.fromEntries(out.map((s) => [s.sessionId, s]))

    // The projection-backed path reads `mode` from state.ts (defaults to
    // 'default' for sessions with no persisted mode) and `isToolSession`
    // from the tool-session table (defaults to false). The fake store's
    // `vendorExtra` is no longer the source — that's the projection's
    // job, and a session with no fact / no tool-session entry shows
    // defaults. State is the new additive field.
    expect(byId['c-old']).toMatchObject({
      vendor: 'claude',
      mode: 'default',
      isToolSession: false,
      lastModified: 100,
      state: 'alive',
    })
    expect(byId['c-new']).toMatchObject({
      vendor: 'claude',
      mode: 'default',
      isToolSession: false,
      lastModified: 400,
      state: 'alive',
    })
    expect(byId['cx-1']).toMatchObject({
      vendor: 'codex',
      mode: 'default',
      isToolSession: false,
      lastModified: 300,
      title: 'Codex one',
      state: 'alive',
    })
  })

  it('returns projected spec sessions on the spec tab even when the intent hides that spec id from work', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Spec row', shortEnTitle: 'spec-row', content: '', priority: 'P1' },
    ])
    setSpecSessionId(intent.id, 'spec-real-1')
    upsertBoundRow({
      sessionId: 'spec-real-1',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'spec-agent',
      title: 'Spec row',
      lastModified: 500,
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: intent.id,
    })
    const accessor = new SessionAccessor([])

    const out = await listSessionsVia(accessor, proj, 'spec')

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      sessionId: 'spec-real-1',
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: intent.id,
    })
  })

  it('gates the tool tab by showToolSessions and returns projected owner metadata when enabled', async () => {
    upsertBoundRow({
      sessionId: 'tool-owned',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'tool-agent',
      title: 'Tool owned',
      lastModified: 600,
      sessionKind: 'tool',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    })
    recordToolSession('tool-owned')
    const accessor = new SessionAccessor([])

    expect(await listSessionsVia(accessor, proj, 'tool')).toEqual([])

    saveSettings({
      agents: [],
      defaultAgentId: 'system',
      toolAgentId: '',
      intentAgentId: '',
      specAgentId: '',
      automationAgentId: '',
      showToolSessions: true,
    })

    const out = await listSessionsVia(accessor, proj, 'tool')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      sessionId: 'tool-owned',
      sessionKind: 'tool',
      ownerKind: 'intent',
      ownerId: 'intent-1',
      isToolSession: true,
    })
  })

  it('rebuilds historical tool markers as ownerless tool projections from native list', async () => {
    saveSettings({
      agents: [],
      defaultAgentId: 'system',
      toolAgentId: '',
      intentAgentId: '',
      specAgentId: '',
      automationAgentId: '',
      showToolSessions: true,
    })
    recordToolSession('tool-historic')
    const claudeSrc: VendorSessionSource = {
      vendor: 'claude',
      sessions: fakeStore([
        {
          sessionId: 'tool-historic',
          title: 'Historic tool',
          vendorExtra: { vendorSessionId: 'tool-historic', lastModified: 700 },
        },
      ]),
    }
    const accessor = new SessionAccessor([claudeSrc])

    const out = await listSessionsVia(accessor, proj, 'tool')

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      sessionId: 'tool-historic',
      sessionKind: 'tool',
      ownerKind: null,
      ownerId: null,
      isToolSession: true,
    })
  })

  it('returns projected discussion sessions only on the discussion tab', async () => {
    upsertBoundRow({
      sessionId: 'work-1',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-work',
      title: 'Work row',
      lastModified: 400,
      sessionKind: 'work',
    })
    upsertBoundRow({
      sessionId: 'discussion-agent-1',
      workspacePath: proj,
      vendor: 'codex',
      agentId: 'agent-discussion',
      title: 'Design review · Agent A',
      lastModified: 500,
      sessionKind: 'discussion',
      ownerKind: 'discussion',
      ownerId: 'discussion-1',
    })
    const accessor = new SessionAccessor([])

    const discussion = await listSessionsVia(accessor, proj, 'discussion')
    const work = await listSessionsVia(accessor, proj, 'work')

    expect(discussion.map((s) => s.sessionId)).toEqual(['discussion-agent-1'])
    expect(discussion[0]).toMatchObject({
      sessionKind: 'discussion',
      ownerKind: 'discussion',
      ownerId: 'discussion-1',
      vendor: 'codex',
    })
    expect(work.map((s) => s.sessionId)).toEqual(['work-1'])
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
    const brokenCodex: VendorSessionSource = {
      vendor: 'codex',
      sessions: {
        list: vi.fn(async () => {
          throw new Error('codex store down')
        }),
        read: vi.fn(async () => []),
      },
    }
    const accessor = new SessionAccessor([claudeSrc, brokenCodex])
    const out = await listSessionsVia(accessor, '/ws')
    expect(out.map((s) => s.sessionId)).toEqual(['c-1'])
  })
})
