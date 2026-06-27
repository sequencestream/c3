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
import type { AgentConfig, ServerToClient, SystemSettings } from '@ccc/shared/protocol'
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
import { resetSettingsCacheForTests, saveSettings } from '../../kernel/config/index.js'
import { resolveSessionVendor } from '../../kernel/agent-config/index.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-open-spec-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
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

function configureCodexSpecAgent(): void {
  const codexAgent: AgentConfig = {
    id: 'codex-spec',
    vendor: 'codex',
    configMode: 'system',
    displayName: 'Codex Spec',
    config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
    enabled: true,
    order_seq: 0,
  }
  saveSettings({
    agents: [codexAgent],
    defaultAgentId: 'codex-spec',
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: 'codex-spec',
  } as SystemSettings)
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

  it('restores a missing Codex spec runtime and pins the spec agent', async () => {
    configureCodexSpecAgent()
    const [r] = insertIntents(proj, [
      { title: 'Codex spec', shortEnTitle: 'codex', content: '', priority: 'P1' },
    ])
    setSpecPath(r.id, join(proj, '.specs/2026/06/27/spec.md'))
    const specId = 'codex-spec-session-1'
    setSpecSessionId(r.id, specId)

    const ctx = {} as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await openSpecSession(ctx, conn, { type: 'open_spec_session', workspaceId, intentId: r.id })

    expect(sent.some((m) => m.type === 'session_selected')).toBe(true)
    expect(resolveSessionVendor(specId)).toBe('codex')
    expect(getRuntime(specId)?.specDir).toBe(join(proj, '.specs/2026/06/27'))

    removeRuntime(specId)
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
