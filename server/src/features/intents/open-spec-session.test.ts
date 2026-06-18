/**
 * `open_spec_session` handler — opens an intent's spec-authoring session for the
 * detail's `spec session` tab. Verifies against the real store/runtime registry
 * that: an existing runtime is reused and replied with a `session_selected`
 * (sessionId = the intent's spec_session_id, viewer registered); a missing spec
 * session id is rejected; and an unknown intent is rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { ensureRuntime, getRuntime, removeRuntime } from '../../runs.js'
import { insertIntents, resetStoreForTests, setSpecPath, setSpecSessionId } from './store.js'
import { openSpecSession } from './index.js'

let dir: string
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-open-spec-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(over: Partial<Conn> = {}): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    subject: 'alice',
    authed: true,
    authToken: null,
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    ...over,
  } as Conn
  return { conn, sent }
}

describe('openSpecSession', () => {
  it('replies with session_selected for the intent spec session and registers the viewer', async () => {
    const [r] = insertIntents(proj, [
      { title: 'Cached endpoint', shortEnTitle: 'cache', content: '', priority: 'P1' },
    ])
    setSpecPath(r.id, '.specs/2026/06/18/2026-06-18-001-cache/spec.md')
    const specId = 'spec-session-1'
    setSpecSessionId(r.id, specId)
    // Pre-create the runtime so the handler reuses it (skips loadHistory).
    ensureRuntime(specId, proj, 'default', [], 'spec')

    const ctx = {} as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await openSpecSession(ctx, conn, { type: 'open_spec_session', workspaceId, intentId: r.id })

    const selected = sent.find((m) => m.type === 'session_selected')
    expect(selected).toBeTruthy()
    expect(selected && selected.type === 'session_selected' && selected.sessionId).toBe(specId)
    expect(conn.viewing).toBe(specId)

    removeRuntime(specId)
  })

  it('rejects an intent with no spec session id', async () => {
    const [r] = insertIntents(proj, [
      { title: 'No spec session', shortEnTitle: 'nospec', content: '', priority: 'P2' },
    ])

    const ctx = {} as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await openSpecSession(ctx, conn, { type: 'open_spec_session', workspaceId, intentId: r.id })

    expect(sent.some((m) => m.type === 'session_selected')).toBe(false)
    expect(sent.find((m) => m.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'intent.chatSessionNotFound' },
    })
    expect(getRuntime('any')).toBeUndefined()
  })

  it('rejects an unknown intent id', async () => {
    const ctx = {} as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await openSpecSession(ctx, conn, {
      type: 'open_spec_session',
      workspaceId,
      intentId: 'nope',
    })

    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
  })
})
