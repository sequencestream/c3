import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToId, resetStateCacheForTests } from '../../state.js'
import { ensureRuntime, removeRuntime } from '../../runs.js'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { getSessionCounts } from './index.js'
import { resetStoreForTests, upsertBoundRow } from './work-session-store.js'

let dir: string
let proj: string
let workspaceId: string
let prevClaudeConfigDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-session-counts-'))
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  proj = join(dir, 'proj')
  mkdirSync(proj)
  addWorkspace(proj, 1)
  workspaceId = pathToId(proj)!
})

afterEach(() => {
  removeRuntime('work-running')
  removeRuntime('spec-running')
  removeRuntime('intent-running')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  return {
    sent,
    conn: {
      send: (m: ServerToClient) => sent.push(m),
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      subject: null,
      authed: true,
      authToken: null,
    } as Conn,
  }
}

describe('getSessionCounts', () => {
  it('counts only running rows inside each session_kind bucket', () => {
    upsertBoundRow({
      sessionId: 'work-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-work',
      title: 'Work',
      sessionKind: 'work',
    })
    upsertBoundRow({
      sessionId: 'spec-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-spec',
      title: 'Spec',
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: 'intent-1',
    })
    upsertBoundRow({
      sessionId: 'spec-idle',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-spec',
      title: 'Spec idle',
      sessionKind: 'spec',
      ownerKind: 'intent',
      ownerId: 'intent-2',
    })
    upsertBoundRow({
      sessionId: 'intent-running',
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'agent-intent',
      title: 'Intent',
      sessionKind: 'intent',
      ownerKind: 'intent',
      ownerId: 'intent-3',
    })

    ensureRuntime('work-running', proj, 'default', [], 'work').run = {
      abort: new AbortController(),
      handle: null,
    }
    ensureRuntime('spec-running', proj, 'default', [], 'spec').run = {
      abort: new AbortController(),
      handle: null,
    }
    ensureRuntime('intent-running', proj, 'default', [], 'intent').run = {
      abort: new AbortController(),
      handle: null,
    }

    const { conn, sent } = fakeConn()
    getSessionCounts({} as KernelContext, conn, { type: 'get_session_counts', workspaceId })

    expect(sent).toEqual([
      {
        type: 'session_counts',
        workspaceId,
        counts: {
          work: 1,
          intent: 1,
          spec: 1,
          discussion: 0,
          schedule: 0,
          tool: 0,
        },
      },
    ])
  })
})
