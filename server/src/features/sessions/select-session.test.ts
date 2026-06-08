/**
 * `select_session` handler branch contract.
 *
 * Two paths matter here and are easy to regress when nearby code changes:
 *  - a normal Claude select cold-loads history (`sessionTitle`/`loadHistory`) and
 *    does NOT touch the opencode lazy-start gate;
 *  - an opencode select lazily (re)starts the supervised server within its grace
 *    window before opening, and a down server is NEVER fatal (the session still
 *    opens — honest degrade, 2026-06-07-003).
 * The IO-heavy collaborators are mocked; we assert the handler's branch contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../runs.js', () => ({
  addViewer: vi.fn(),
  emit: vi.fn(),
  ensureRuntime: vi.fn(() => ({ mode: 'default', baseline: [], status: 'idle', buffer: [] })),
  getRuntime: vi.fn(() => undefined),
  removeRuntime: vi.fn(),
  removeViewer: vi.fn(),
  setStatus: vi.fn(),
  stopRun: vi.fn(),
}))
vi.mock('../../state.js', () => ({
  getActiveSessionId: vi.fn(() => null),
  getSessionMode: vi.fn(() => 'default'),
  hasWorkspace: vi.fn(() => true),
  setActiveSessionId: vi.fn(),
  setSessionMode: vi.fn(),
  touchWorkspace: vi.fn(),
}))
vi.mock('../../sessions.js', () => ({
  loadHistory: vi.fn(async () => []),
  sessionTitle: vi.fn(async () => 'Untitled session'),
  removeSession: vi.fn(),
  renameWorkspaceSession: vi.fn(),
}))
vi.mock('../../kernel/config/index.js', () => ({
  getDefaultMode: vi.fn((_path?: string, _vendor?: string) => 'default'),
}))
vi.mock('../../kernel/agent-config/index.js', () => ({
  resolveAgent: vi.fn(() => ({ id: 'sys', vendor: 'claude' })),
  resolveSessionAgentSwitch: vi.fn(() => null),
  resolveSessionVendor: vi.fn(() => 'claude'),
  setSessionAgent: vi.fn(() => ({ ok: true })),
}))
vi.mock('../../kernel/agent/process/launcher.js', () => ({ probeAll: vi.fn(() => []) }))
vi.mock('../../opencode-status.js', () => ({ ensureOpencodeRunning: vi.fn(async () => {}) }))

import { selectSession } from './index.js'
import { loadHistory, sessionTitle } from '../../sessions.js'
import { resolveSessionVendor } from '../../kernel/agent-config/index.js'
import { ensureOpencodeRunning } from '../../opencode-status.js'

afterEach(() => vi.clearAllMocks())

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

describe('select_session', () => {
  it('normal Claude select → cold-loads history, no opencode lazy-start', async () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspacePath: '/abs/proj',
      sessionId: 'claude-1',
    })
    expect(loadHistory).toHaveBeenCalledWith('/abs/proj', 'claude-1')
    expect(sessionTitle).toHaveBeenCalled()
    // Claude is not server-backed ⇒ no opencode lazy-start.
    expect(ensureOpencodeRunning).not.toHaveBeenCalled()
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.vendor).toBe('claude')
  })

  it('opencode select → lazily ensures the server (grace), opens the session, never fatal', async () => {
    vi.mocked(resolveSessionVendor).mockReturnValue('opencode')
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspacePath: '/abs/proj',
      sessionId: 'opencode-1',
    })
    // The lazy-start gate fired before reading; opencode read='full' ⇒ normal path.
    expect(ensureOpencodeRunning).toHaveBeenCalledOnce()
    // Honest degrade contract: a down server is NEVER fatal — the session still opens.
    expect(conn.sent.some((m) => m.type === 'error')).toBe(false)
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.vendor).toBe('opencode')
  })
})
