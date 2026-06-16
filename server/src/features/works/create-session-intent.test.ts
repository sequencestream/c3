/**
 * `create_session` records the chosen agent as the pending session's *intent*
 * (ADR-0015, work_session_metadata projection amendment). The intent now lives in
 * the `work_session_metadata` projection table as a `pending` row, not in
 * `state.json`. An absent/empty `agentId` resolves to Auto (no intent — the
 * projection row still gets written with the default agent's vendor + id).
 *
 * The runtime/state side effects (`ensureRuntime`, viewer wiring, workspace
 * touch) are mocked so the test exercises only the intent-writing path. A
 * real `c3.db` is opened in a throwaway temp dir so the projection store
 * writes and reads work end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetStoreForTests } from './work-session-store.js'

vi.mock('../../runs.js', () => ({
  addViewer: vi.fn(),
  ensureRuntime: vi.fn(),
  removeViewer: vi.fn(),
}))
vi.mock('../../state.js', () => ({
  hasWorkspace: vi.fn(() => true),
  // Identity stubs: the test passes a path as the workspaceId (registered).
  resolveWorkspaceRoot: vi.fn((id: string) => id),
  pathToId: vi.fn((p: string) => p),
  touchWorkspace: vi.fn(),
}))

import { createSession } from './index.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { getPendingIntent } from './work-session-store.js'

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-create-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  resetDbForTests()
  resetStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** A minimal connection that records the messages it is sent. */
function fakeConn() {
  const sent: Array<{ type: string; [k: string]: unknown }> = []
  return {
    viewing: null as string | null,
    deliver: () => {},
    send: (m: { type: string; [k: string]: unknown }) => sent.push(m),
    sendWorkspaces: () => {},
    sent,
  }
}

/** The pending session id the handler minted (from its `session_selected`). */
function pendingIdOf(conn: ReturnType<typeof fakeConn>): string {
  const sel = conn.sent.find((m) => m.type === 'session_selected')
  return sel?.sessionId as string
}

describe('create_session agent intent (projection-backed)', () => {
  it('records the chosen agent in the projection as a pending row', () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, {
      type: 'create_session',
      workspaceId: '/abs/proj',
      agentId: 'claude-b',
    })
    const pendingId = pendingIdOf(conn)
    expect(pendingId).toMatch(/^pending:/)
    // The intent is in the projection table (the new home after ADR-0015 +
    // work_session_metadata amendment). The handler writes a pending row via
    // `upsertPendingRow`; the intent's agent id is in the row.
    const intent = getPendingIntent(pendingId)
    expect(intent?.agentId).toBe('claude-b')
  })

  it('Auto (no agentId) writes a pending row with the default agent', () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, {
      type: 'create_session',
      workspaceId: '/abs/proj',
    })
    const pendingId = pendingIdOf(conn)
    const intent = getPendingIntent(pendingId)
    // Auto mode: the handler resolves the default agent (resolveAgent(null)) and
    // writes a pending row with the default agent's id.
    expect(intent?.agentId).toBeTruthy()
  })

  it('an empty-string agentId is Auto too (default agent, not null)', () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, {
      type: 'create_session',
      workspaceId: '/abs/proj',
      agentId: '',
    })
    const pendingId = pendingIdOf(conn)
    const intent = getPendingIntent(pendingId)
    expect(intent?.agentId).toBeTruthy()
  })
})
