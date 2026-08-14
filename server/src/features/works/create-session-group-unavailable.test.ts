/**
 * `create_session` refuses — whole — when the agent it would bind is a group with
 * no usable member.
 *
 * The refusal must be atomic: no runtime, no pending projection row, no viewer
 * move, no `session_selected`. A session that silently landed on some other agent
 * (the old "empty group ⇒ fall back to the default/System" behaviour) is exactly
 * what this pins against — a user who configured a group and sees `System` running
 * has no way to tell the configuration is broken.
 *
 * The unusable-group case constructed here is the one a user can actually reach:
 * the group's vendor has no runtime on this machine (an all-disabled group is
 * rewritten by settings normalization before it can be persisted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, VendorId } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetStoreForTests } from './work-session-store.js'

vi.mock('../../runs.js', () => ({
  addViewer: vi.fn(),
  ensureRuntime: vi.fn(),
  removeViewer: vi.fn(),
}))
vi.mock('../../state.js', () => ({
  hasWorkspace: vi.fn(() => true),
  resolveWorkspaceRoot: vi.fn((id: string) => id),
  pathToName: vi.fn((p: string) => p),
  workspaceNameFor: vi.fn((value: string) => value),
  touchWorkspace: vi.fn(),
}))

let available: Set<VendorId> = new Set(['claude'])
vi.mock('../../kernel/agent/vendor-runtime.js', () => ({
  availableVendorSet: () => available,
}))

import { createSession } from './index.js'
import { ensureRuntime } from '../../runs.js'
import {
  loadSettings,
  resetSettingsCacheForTests,
  saveSettings,
} from '../../kernel/config/index.js'
import { systemAgent } from '../../kernel/agent-config/index.js'
import { getPendingIntent } from './work-session-store.js'

const GROUP = '_c3_claude_fast'

let dir: string
let prevHome: string | undefined

function member(id: string, order: number): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: 'system',
    displayName: id,
    enabled: true,
    order_seq: order,
    group: 'fast',
    config: { baseUrl: '', apiKey: '', model: '' },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'c3-create-group-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
  available = new Set<VendorId>(['claude'])
  saveSettings({
    ...loadSettings(),
    agents: [systemAgent(), member('m1', 1), member('m2', 2)],
    defaultAgentId: GROUP,
  })
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

function fakeConn() {
  const sent: Array<{ type: string; [k: string]: unknown }> = []
  return {
    viewing: 'previous-session' as string | null,
    deliver: () => {},
    send: (m: { type: string; [k: string]: unknown }) => sent.push(m),
    sendWorkspaces: () => {},
    sent,
  }
}

describe('create_session with a group agent', () => {
  it('Auto on a usable group binds the GROUP ref with its first member’s vendor', () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, { type: 'create_session', workspaceName: '/abs/proj' })

    const selected = conn.sent.find((m) => m.type === 'session_selected')
    const pendingId = selected?.sessionId as string
    expect(pendingId).toMatch(/^pending:/)
    expect(getPendingIntent(pendingId)?.agentId).toBe(GROUP)
    expect(selected?.vendor).toBe('claude')
  })

  it('refuses with agent.groupUnavailable — and builds nothing — when the group cannot run', () => {
    available = new Set<VendorId>()
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, { type: 'create_session', workspaceName: '/abs/proj' })

    expect(conn.sent).toEqual([
      { type: 'error', error: { code: 'agent.groupUnavailable', params: { group: GROUP } } },
    ])
    expect(conn.sent.some((m) => m.type === 'session_selected')).toBe(false)
    expect(ensureRuntime).not.toHaveBeenCalled()
    // The connection keeps watching what it had — no half-switched view.
    expect(conn.viewing).toBe('previous-session')
  })
})
