/**
 * The spec-session hidden filter in `listSessionsVia` (`list-sessions.ts`):
 * an intent's spec session (`spec_session_id`) is NOT a user work session and
 * must NOT appear in the Work Sessions list, alongside the existing
 * comm-session hidden set. A normal session and an intent dev session
 * (`last_work_session_id`) must keep showing — the filter key is strictly the
 * spec session id.
 *
 * The SDK `listSessions` is mocked (as in `list-sessions.test.ts`) so the
 * projection rebuild reads our fixture sessions and the test exercises only the
 * c3 filtering layer.
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
import { resetStoreForTests, insertIntents, setSpecSessionId } from './features/intents/store.js'
import { resetStoreForTests as resetSessionsStoreForTests } from './features/works/work-session-store.js'
import { ClaudeSessionStore } from './kernel/agent/adapters/claude/session-store.js'
import { SessionAccessor } from './kernel/agent/session/accessor.js'
import { listSessionsVia } from './kernel/agent/session/list-sessions.js'

const proj = '/abs/spec-hidden-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-hidden-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetSessionsStoreForTests()
  listSessionsMock.mockReset()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

// `spec-1` is the spec session; `dev-1` an intent dev session; `normal-1` a
// plain work session. All three land in the projection via the rebuild.
const sdkSessions = [
  { sessionId: 'normal-1', firstPrompt: 'hello', lastModified: 100 },
  { sessionId: 'spec-1', firstPrompt: 'spec', lastModified: 200 },
  { sessionId: 'dev-1', firstPrompt: 'dev', lastModified: 300 },
]

describe('listSessionsVia — spec-session hidden filter', () => {
  it('excludes the intent spec session, keeps the dev and normal sessions', async () => {
    listSessionsMock.mockResolvedValue(sdkSessions)
    const [intent] = insertIntents(proj, [
      { title: 'i', shortEnTitle: 'i', content: 'c', priority: 'P2' },
    ])
    setSpecSessionId(intent.id, 'spec-1')

    const out = await listSessionsVia(
      new SessionAccessor([{ vendor: 'claude', sessions: new ClaudeSessionStore() }]),
      proj,
    )

    const ids = out.map((s) => s.sessionId)
    expect(ids).not.toContain('spec-1')
    expect(ids).toContain('normal-1')
    // The dev session (`last_work_session_id`, not `spec_session_id`) is a real
    // work session and must survive the filter.
    expect(ids).toContain('dev-1')
  })

  it('does not hide spec sessions belonging to a different workspace', async () => {
    listSessionsMock.mockResolvedValue(sdkSessions)
    // An intent in another workspace records `spec-1` as its spec session; the
    // filter is workspace-scoped, so `spec-1` must still show for `proj`.
    const [other] = insertIntents('/abs/other-proj', [
      { title: 'o', shortEnTitle: 'o', content: 'c', priority: 'P2' },
    ])
    setSpecSessionId(other.id, 'spec-1')

    const out = await listSessionsVia(
      new SessionAccessor([{ vendor: 'claude', sessions: new ClaudeSessionStore() }]),
      proj,
    )
    expect(out.map((s) => s.sessionId)).toContain('spec-1')
  })
})
