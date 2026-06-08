/**
 * Integration test for the hidden-session filter in `listWorkspaceSessions`
 * (US-3 AC-3.4, design §4.8): intent comm sessions recorded in the store
 * must NOT appear in the normal session list, and the list must degrade to
 * "show everything" when the store/db is unavailable.
 *
 * The SDK `listSessions` (which reads JSONL transcripts off disk) is mocked so
 * the test is hermetic — we only verify the c3 filtering layer, not the SDK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock only the session-introspection surface; keep the rest of the SDK intact.
// `vi.hoisted` makes the mock fn available inside the hoisted `vi.mock` factory.
const { listSessionsMock } = vi.hoisted(() => ({ listSessionsMock: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, listSessions: listSessionsMock }
})

import { resetDbForTests } from './kernel/infra/db.js'
import { resetStoreForTests, setChatSession } from './features/intents/store.js'
import { listWorkspaceSessions } from './sessions.js'

const proj = '/abs/hidden-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-hidden-'))
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
  { sessionId: 'comm-abc', firstPrompt: '需求', lastModified: 200 },
  { sessionId: 'normal-2', firstPrompt: 'world', lastModified: 300 },
]

describe('listWorkspaceSessions hidden filter', () => {
  it('excludes the project comm session from the normal list (AC-3.4)', async () => {
    // The comm session id recorded via setChatSession lands in the hidden set and
    // must be filtered out; the remaining sessions return newest-first.
    setChatSession(proj, 'comm-abc')
    listSessionsMock.mockResolvedValue(sdkSessions)

    const out = await listWorkspaceSessions(proj)
    expect(out.map((s) => s.sessionId)).toEqual(['normal-2', 'normal-1'])
    expect(out.some((s) => s.sessionId === 'comm-abc')).toBe(false)
  })

  it('filters using the resolved path key, regardless of how dir is spelled', async () => {
    // §4.8: the store keys by resolve(projectPath); the filter must resolve(dir)
    // too. Passing a trailing-slash dir still finds the hidden id.
    setChatSession(proj, 'comm-abc')
    listSessionsMock.mockResolvedValue(sdkSessions)
    const out = await listWorkspaceSessions(`${proj}/`)
    expect(out.some((s) => s.sessionId === 'comm-abc')).toBe(false)
    expect(out.map((s) => s.sessionId).sort()).toEqual(['normal-1', 'normal-2'])
  })

  it('excludes multiple intent sessions (all are hidden, not just is_current)', async () => {
    // Multiple setChatSession calls produce multiple rows; ALL must be hidden.
    setChatSession(proj, 'comm-abc')
    setChatSession(proj, 'comm-xyz')
    listSessionsMock.mockResolvedValue(sdkSessions)

    const out = await listWorkspaceSessions(proj)
    expect(out.map((s) => s.sessionId)).toEqual(['normal-2', 'normal-1'])
    expect(out.some((s) => s.sessionId === 'comm-abc')).toBe(false)
    expect(out.some((s) => s.sessionId === 'comm-xyz')).toBe(false)
  })

  it('shows everything (no filtering) when the store/db is unavailable', async () => {
    // Degradation: a broken db ⇒ empty hidden set ⇒ the list is not pruned, so a
    // db problem never hides real sessions.
    resetDbForTests()
    resetStoreForTests()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    listSessionsMock.mockResolvedValue(sdkSessions)
    const out = await listWorkspaceSessions(proj)
    expect(out.map((s) => s.sessionId).sort()).toEqual(['comm-abc', 'normal-1', 'normal-2'])
  })
})
