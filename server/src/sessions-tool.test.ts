/**
 * Integration test for the tool-session filter in `listWorkspaceSessions`.
 *
 * Tool-created sessions (completion judge, consensus advisor) are tagged via
 * `addToolSession`, which write-throughs to the persisted `tool_sessions` table.
 * The persistence is what makes the "Show tool sessions" setting (off by
 * default) keep working across restarts: a previous process records the tag,
 * and a fresh process — whose in-memory cache is empty — must still recognise
 * the session via the db and hide it. Deleting a session must also drop its
 * persisted tag.
 *
 * The SDK `listSessions` / `deleteSession` (which touch JSONL on disk) are
 * mocked so the test exercises only the c3 filtering + persistence layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { listSessionsMock, deleteSessionMock } = vi.hoisted(() => ({
  listSessionsMock: vi.fn(),
  deleteSessionMock: vi.fn(),
}))
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, listSessions: listSessionsMock, deleteSession: deleteSessionMock }
})

import { resetDbForTests } from './db.js'
import {
  resetStoreForTests,
  recordToolSession,
  isToolSessionRecorded,
} from './features/requirements/store.js'
import { addToolSession, isToolSession, listWorkspaceSessions, removeSession } from './sessions.js'

const proj = '/abs/tool-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-tool-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  listSessionsMock.mockReset()
  deleteSessionMock.mockReset()
  deleteSessionMock.mockResolvedValue(undefined)
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

const sdkSessions = [
  { sessionId: 'normal-1', firstPrompt: 'hello', lastModified: 100 },
  { sessionId: 'tool-abc', firstPrompt: 'judge', lastModified: 200 },
  { sessionId: 'normal-2', firstPrompt: 'world', lastModified: 300 },
]

describe('listWorkspaceSessions tool-session filter', () => {
  it('hides a tool session that is only known via the persisted db (restart case)', async () => {
    // Simulate a tag written by a previous process: only the db row exists, the
    // in-memory cache is empty. The fresh process must still hide it.
    recordToolSession('tool-abc')
    listSessionsMock.mockResolvedValue(sdkSessions)

    const out = await listWorkspaceSessions(proj)
    expect(out.map((s) => s.sessionId)).toEqual(['normal-2', 'normal-1'])
    expect(out.some((s) => s.sessionId === 'tool-abc')).toBe(false)
  })

  it('addToolSession persists the tag (survives a store reset)', () => {
    addToolSession('tool-abc')
    expect(isToolSessionRecorded('tool-abc')).toBe(true)
    // A "restart": drop the in-memory cache; the db must still know the tag.
    resetStoreForTests()
    expect(isToolSession('tool-abc')).toBe(true)
  })

  it('removeSession deletes the transcript and the persisted tag', async () => {
    addToolSession('tool-abc')
    expect(isToolSessionRecorded('tool-abc')).toBe(true)

    await removeSession(dir, 'tool-abc')

    expect(deleteSessionMock).toHaveBeenCalledWith('tool-abc', { dir })
    expect(isToolSessionRecorded('tool-abc')).toBe(false)
    // And the now-untagged id is no longer filtered out of the list.
    listSessionsMock.mockResolvedValue(sdkSessions)
    const out = await listWorkspaceSessions(proj)
    expect(out.some((s) => s.sessionId === 'tool-abc')).toBe(true)
  })
})
