/**
 * `create_session` records the chosen agent as the pending session's *intent*
 * (ADR-0015), and treats an absent/empty `agentId` as **Auto** (no intent, the
 * run falls back to the default agent).
 *
 * The runtime/state side effects (`ensureRuntime`, viewer wiring, workspace
 * touch) are mocked so the test exercises only the intent-writing path; the
 * config store writes to a throwaway `$HOME/.c3/state.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../runs.js', () => ({
  addViewer: vi.fn(),
  ensureRuntime: vi.fn(),
  removeViewer: vi.fn(),
}))
vi.mock('../../state.js', () => ({
  hasWorkspace: vi.fn(() => true),
  touchWorkspace: vi.fn(),
}))

import { createSession } from './index.js'
import { getSessionAgentId, resetSettingsCacheForTests } from '../../kernel/config/index.js'

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-create-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
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

describe('create_session agent intent', () => {
  it('records the chosen agent as the pending intent', () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, {
      type: 'create_session',
      workspacePath: '/abs/proj',
      agentId: 'claude-b',
    })
    const pendingId = pendingIdOf(conn)
    expect(pendingId).toMatch(/^pending:/)
    expect(getSessionAgentId(pendingId)).toBe('claude-b')
  })

  it('Auto (no agentId) writes no intent — resolution falls back to the default', () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, {
      type: 'create_session',
      workspacePath: '/abs/proj',
    })
    expect(getSessionAgentId(pendingIdOf(conn))).toBeNull()
  })

  it('an empty-string agentId is Auto too (no intent written)', () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, {
      type: 'create_session',
      workspacePath: '/abs/proj',
      agentId: '',
    })
    expect(getSessionAgentId(pendingIdOf(conn))).toBeNull()
  })
})
