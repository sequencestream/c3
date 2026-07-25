/**
 * `delete_intent` session cleanup — vendor dispatch + per-step fencing.
 *
 * An intent may hold sessions from more than one vendor. Only a vendor whose
 * session store can delete (Claude) may hand its id to the SDK transcript
 * remover; a Codex id used to raise "Session not found" and abort the whole
 * delete, stranding the intent's db records and git resources. These tests pin:
 * Codex sessions skip the transcript remover but still lose every c3-side
 * reference; a Claude session still deletes its transcript (and a duplicated id
 * is handled once); and a failing cleanup step never stops the steps behind it,
 * the remaining sessions, `removeIntentGitResources` or `deleteIntentRecords` —
 * the intent row goes away regardless, so a stranded session row is an orphan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, ServerToClient, SystemSettings } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'

const hoisted = vi.hoisted(() => ({
  runtimeFailureSessionId: null as string | null,
  chatFailureSessionId: null as string | null,
}))

vi.mock('../../sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sessions.js')>()
  return { ...actual, removeSession: vi.fn(async () => {}) }
})
vi.mock('../../runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runs.js')>()
  return {
    ...actual,
    removeRuntime: vi.fn((sessionId: string) => {
      // Stand-in for any per-session step blowing up mid-cleanup.
      if (sessionId === hoisted.runtimeFailureSessionId) throw new Error('runtime abort failed')
      return actual.removeRuntime(sessionId)
    }),
  }
})
vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>()
  return {
    ...actual,
    deleteChatSession: vi.fn((workspacePath: string, sessionId: string) => {
      // Stand-in for a mid-cleanup step failing after the earlier ones ran.
      if (sessionId === hoisted.chatFailureSessionId) throw new Error('chat row delete failed')
      return actual.deleteChatSession(workspacePath, sessionId)
    }),
  }
})
vi.mock('./worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree.js')>()
  return {
    ...actual,
    removeIntentGitResources: vi.fn(() => ({ worktreeRemoved: false, branchRemoved: false })),
  }
})

import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetSettingsCacheForTests, saveSettings } from '../../kernel/config/index.js'
import { setSessionAgent } from '../../kernel/agent-config/index.js'
import {
  listAll as listMetadataRows,
  resetStoreForTests as resetMetadataStoreForTests,
  upsertBoundRow,
} from '../sessions/session-metadata-store.js'
import { removeSession } from '../../sessions.js'
import { removeIntentGitResources } from './worktree.js'
import {
  getIntent,
  insertIntentSession,
  insertIntents,
  listChatSessions,
  resetStoreForTests,
  setChatSession,
  setIntentSessionId,
  setSpecSessionId,
} from './store.js'
import { deleteIntent } from './index.js'

const CLAUDE_AGENT = 'claude-a'
const CODEX_AGENT = 'codex-a'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-delete-intent-vendor-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
  hoisted.runtimeFailureSessionId = null
  hoisted.chatFailureSessionId = null
  configureAgents()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function agent(id: string, vendor: 'claude' | 'codex'): AgentConfig {
  return {
    id,
    vendor,
    configMode: 'system',
    displayName: id,
    config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
    enabled: true,
    order_seq: 0,
  } as AgentConfig
}

/** Both vendors available, Claude as the default (so an unbound id is Claude). */
function configureAgents(): void {
  saveSettings({
    agents: [agent(CLAUDE_AGENT, 'claude'), agent(CODEX_AGENT, 'codex')],
    defaultAgentId: CLAUDE_AGENT,
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: '',
  } as SystemSettings)
}

/** Register a session on both c3-side projections, bound to `agentId`'s vendor. */
function seedSession(sessionId: string, agentId: string, vendor: 'claude' | 'codex'): void {
  setSessionAgent(sessionId, agentId)
  setChatSession(proj, sessionId, `title ${sessionId}`)
  upsertBoundRow({
    sessionId,
    workspacePath: proj,
    vendor,
    agentId,
    title: `title ${sessionId}`,
    sessionKind: 'work',
  })
}

function harness() {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    subject: 'alice',
    viewing: null as string | null,
  } as unknown as Conn
  const ctx = {
    broadcastIntents: vi.fn(),
    broadcastIntentSessions: vi.fn(),
    broadcastStatuses: vi.fn(),
  } as unknown as KernelContext
  return { sent, conn, ctx }
}

function newIntent(title: string): string {
  const [row] = insertIntents(proj, [{ title, shortEnTitle: 'x', content: '', priority: 'P2' }])
  return row.id
}

describe('deleteIntent — vendor-dispatched session cleanup', () => {
  it('skips the Claude transcript remover for Codex sessions yet drops every c3 reference and broadcasts', async () => {
    const id = newIntent('codex intent')
    seedSession('codex-comm', CODEX_AGENT, 'codex')
    seedSession('codex-spec', CODEX_AGENT, 'codex')
    seedSession('codex-work', CODEX_AGENT, 'codex')
    setIntentSessionId(id, 'codex-comm')
    setSpecSessionId(id, 'codex-spec')
    insertIntentSession(id, 'codex-work', 'codex', CODEX_AGENT)

    const h = harness()
    h.conn.viewing = 'codex-comm'
    await deleteIntent(h.ctx, h.conn, { type: 'delete_intent', workspaceId, intentId: id })

    expect(removeSession).not.toHaveBeenCalled()
    expect(getIntent(id)).toBeNull()
    expect(listChatSessions(proj)).toEqual([])
    expect(listMetadataRows()).toEqual([])
    expect(removeIntentGitResources).toHaveBeenCalledWith(proj, id, null)
    expect(h.conn.viewing).toBeNull()
    expect(h.sent.some((m) => m.type === 'error')).toBe(false)
    expect(h.ctx.broadcastIntents).toHaveBeenCalledWith(proj)
    expect(h.ctx.broadcastIntentSessions).toHaveBeenCalledWith(proj)
    expect(h.ctx.broadcastStatuses).toHaveBeenCalledOnce()
  })

  it('still deletes a Claude transcript, and a duplicated session id only once', async () => {
    const id = newIntent('claude intent')
    seedSession('claude-comm', CLAUDE_AGENT, 'claude')
    // The same id in all three slots — the handler de-dups before cleaning up.
    setIntentSessionId(id, 'claude-comm')
    setSpecSessionId(id, 'claude-comm')
    insertIntentSession(id, 'claude-comm', 'claude', CLAUDE_AGENT)

    const h = harness()
    await deleteIntent(h.ctx, h.conn, { type: 'delete_intent', workspaceId, intentId: id })

    expect(removeSession).toHaveBeenCalledOnce()
    expect(removeSession).toHaveBeenCalledWith(proj, 'claude-comm')
    expect(getIntent(id)).toBeNull()
    expect(listChatSessions(proj)).toEqual([])
    expect(listMetadataRows()).toEqual([])
    expect(h.sent.some((m) => m.type === 'error')).toBe(false)
  })

  it('drops the c3 references even when the Claude transcript is already gone', async () => {
    const id = newIntent('missing transcript')
    seedSession('claude-gone', CLAUDE_AGENT, 'claude')
    setIntentSessionId(id, 'claude-gone')
    vi.mocked(removeSession).mockRejectedValueOnce(
      new Error('Session claude-gone not found in project directory'),
    )

    const h = harness()
    await deleteIntent(h.ctx, h.conn, { type: 'delete_intent', workspaceId, intentId: id })

    expect(listChatSessions(proj)).toEqual([])
    expect(listMetadataRows()).toEqual([])
    expect(getIntent(id)).toBeNull()
    expect(removeIntentGitResources).toHaveBeenCalledOnce()
    expect(h.sent.some((m) => m.type === 'error')).toBe(false)
  })

  it('drops the failing session’s own c3 rows too, plus the remaining sessions and intent resources', async () => {
    const id = newIntent('partial failure')
    seedSession('boom', CLAUDE_AGENT, 'claude')
    seedSession('codex-work', CODEX_AGENT, 'codex')
    setIntentSessionId(id, 'boom')
    insertIntentSession(id, 'codex-work', 'codex', CODEX_AGENT)
    // An early step (runtime teardown) blows up — the steps behind it must run
    // anyway, or `boom` keeps rows pointing at an intent deleted just below.
    hoisted.runtimeFailureSessionId = 'boom'

    const h = harness()
    await deleteIntent(h.ctx, h.conn, { type: 'delete_intent', workspaceId, intentId: id })

    expect(listChatSessions(proj)).toEqual([])
    expect(listMetadataRows()).toEqual([])
    expect(removeIntentGitResources).toHaveBeenCalledOnce()
    expect(getIntent(id)).toBeNull()
    expect(h.sent.some((m) => m.type === 'error')).toBe(false)
    expect(h.ctx.broadcastIntents).toHaveBeenCalledWith(proj)
  })

  it('still deletes the session projection when the chat-row delete throws', async () => {
    const id = newIntent('chat row fails')
    seedSession('chat-boom', CODEX_AGENT, 'codex')
    setIntentSessionId(id, 'chat-boom')
    hoisted.chatFailureSessionId = 'chat-boom'

    const h = harness()
    await deleteIntent(h.ctx, h.conn, { type: 'delete_intent', workspaceId, intentId: id })

    // The chat row survives (its own delete threw) — proof the step really
    // failed — yet the projection delete behind it still ran.
    expect(listChatSessions(proj).map((s) => s.sessionId)).toEqual(['chat-boom'])
    expect(listMetadataRows()).toEqual([])
    expect(getIntent(id)).toBeNull()
    expect(removeIntentGitResources).toHaveBeenCalledOnce()
    expect(h.sent.some((m) => m.type === 'error')).toBe(false)
  })
})
