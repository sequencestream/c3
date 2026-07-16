/**
 * `set_session_agent` re-targets a real session's agent within its frozen vendor
 * (ADR-0015 / AS-R22): a same-vendor swap rewrites the `sessionAgents` fact and
 * replies `session_agent_changed { ok: true }`; a cross-vendor change is rejected
 * (`{ ok: false }`, fact untouched) — the defensive guard behind the console's
 * same-vendor-only switcher. The config store writes to a throwaway state.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'

vi.mock('../../runs.js', () => ({
  addViewer: vi.fn(),
  emit: vi.fn(),
  ensureRuntime: vi.fn(),
  getRuntime: vi.fn(),
  removeRuntime: vi.fn(),
  removeViewer: vi.fn(),
  setStatus: vi.fn(),
  stopRun: vi.fn(),
}))
vi.mock('../../state.js', () => ({
  getActiveSessionId: vi.fn(),
  getSessionMode: vi.fn(),
  hasWorkspace: vi.fn(() => true),
  setActiveSessionId: vi.fn(),
  setSessionMode: vi.fn(),
  touchWorkspace: vi.fn(),
}))

import { setSessionAgentHandler } from './index.js'
import {
  bindSessionAgent,
  getSessionAgentId,
  resetSettingsCacheForTests,
  saveSettings,
} from '../../kernel/config/index.js'

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-setagent-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
  saveSettings({
    agents: [
      {
        id: SYSTEM_AGENT_ID,
        vendor: 'claude',
        configMode: 'system',
        displayName: 'System',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'claude-b',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'Claude B',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'cx',
        vendor: 'codex',
        configMode: 'custom',
        displayName: 'CX',
        config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
      },
    ],
    defaultAgentId: SYSTEM_AGENT_ID,
  } as unknown as SystemSettings)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn() {
  const sent: Array<{ type: string; [k: string]: unknown }> = []
  return {
    viewing: null as string | null,
    deliver: () => {},
    send: (m: { type: string; [k: string]: unknown }) => sent.push(m),
    sent,
  }
}

describe('set_session_agent handler', () => {
  it('applies a same-vendor swap and replies ok with the unchanged vendor', () => {
    bindSessionAgent('pending:a', 'real-1', SYSTEM_AGENT_ID, 'claude', 'host')
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSessionAgentHandler({} as any, conn as any, {
      type: 'set_session_agent',
      sessionId: 'real-1',
      agentId: 'claude-b',
    })
    expect(conn.sent).toEqual([
      {
        type: 'session_agent_changed',
        sessionId: 'real-1',
        agentId: 'claude-b',
        vendor: 'claude',
        ok: true,
      },
    ])
    expect(getSessionAgentId('real-1')).toBe('claude-b')
  })

  it('rejects a cross-vendor change and leaves the fact untouched', () => {
    bindSessionAgent('pending:b', 'real-2', SYSTEM_AGENT_ID, 'claude', 'host')
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSessionAgentHandler({} as any, conn as any, {
      type: 'set_session_agent',
      sessionId: 'real-2',
      agentId: 'cx',
    })
    const reply = conn.sent[0] as unknown as { ok: boolean; vendor: string }
    expect(reply.ok).toBe(false)
    // Vendor stays the frozen claude; the fact still points at the original agent.
    expect(reply.vendor).toBe('claude')
    expect(getSessionAgentId('real-2')).toBe(SYSTEM_AGENT_ID)
  })
})
