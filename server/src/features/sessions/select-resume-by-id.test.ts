/**
 * `select_session` resume-by-id for an unenumerable vendor (Codex, 2026-06-07-002).
 *
 * The projection/native store has never seen a pasted Codex id, and Codex reports
 * `read: 'none'` — so the Claude-only cold-load (`sessionTitle`/`loadHistory`)
 * would throw → `openFailed`. The handler instead skips that path, seeds an empty
 * baseline, and binds the id to a vendor-matching agent so the next turn resumes
 * natively. The real fact-binding (`setSessionAgent`) is covered by
 * `session-agent-binding.test.ts`; here we mock the IO-heavy collaborators and
 * assert the handler's branch contract.
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
  getDefaultMode: vi.fn(() => 'default'),
  getSessionAgentId: vi.fn(() => null),
}))
vi.mock('../../kernel/agent-config/index.js', () => ({
  firstAgentForVendor: vi.fn(),
  resolveAgent: vi.fn(() => ({ id: 'sys', vendor: 'claude' })),
  resolveSessionAgentSwitch: vi.fn(() => null),
  resolveSessionVendor: vi.fn(() => 'claude'),
  setSessionAgent: vi.fn(() => ({ ok: true })),
}))
vi.mock('../../kernel/agent/process/launcher.js', () => ({ probeAll: vi.fn(() => []) }))
vi.mock('../../opencode-status.js', () => ({ ensureOpencodeRunning: vi.fn(async () => {}) }))

import { selectSession } from './index.js'
import { loadHistory, sessionTitle } from '../../sessions.js'
import { ensureRuntime } from '../../runs.js'
import {
  firstAgentForVendor,
  resolveSessionVendor,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
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

describe('select_session resume-by-id (Codex, unenumerable)', () => {
  it('vendor=codex + unknown id → skips Claude cold-load, empty baseline, binds a codex agent', async () => {
    vi.mocked(firstAgentForVendor).mockReturnValue({ id: 'codex-a', vendor: 'codex' } as never)
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspacePath: '/abs/proj',
      sessionId: 'codex-thread-1',
      vendor: 'codex',
    })
    // The Claude-only path is never touched (it would throw for a Codex id).
    expect(loadHistory).not.toHaveBeenCalled()
    expect(sessionTitle).not.toHaveBeenCalled()
    // The id is bound to the resolved codex agent so the next turn resumes natively.
    expect(setSessionAgent).toHaveBeenCalledWith('codex-thread-1', 'codex-a')
    // Empty baseline seeded; reply carries the codex vendor.
    expect(ensureRuntime).toHaveBeenCalledWith('codex-thread-1', '/abs/proj', 'default', [])
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.vendor).toBe('codex')
    expect(sel?.history).toEqual([])
  })

  it('vendor=codex but no codex agent configured → honest resumeNoAgent error, no runtime', async () => {
    vi.mocked(firstAgentForVendor).mockReturnValue(null)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspacePath: '/abs/proj',
      sessionId: 'codex-thread-2',
      vendor: 'codex',
    })
    const err = conn.sent.find((m) => m.type === 'error')
    expect((err?.error as { code: string }).code).toBe('session.resumeNoAgent')
    expect(setSessionAgent).not.toHaveBeenCalled()
    expect(ensureRuntime).not.toHaveBeenCalled()
  })

  it('no vendor hint (normal Claude select) → cold-loads history as before', async () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspacePath: '/abs/proj',
      sessionId: 'claude-1',
    })
    expect(loadHistory).toHaveBeenCalledWith('/abs/proj', 'claude-1')
    expect(sessionTitle).toHaveBeenCalled()
    expect(firstAgentForVendor).not.toHaveBeenCalled()
    // Claude is not server-backed ⇒ no opencode lazy-start.
    expect(ensureOpencodeRunning).not.toHaveBeenCalled()
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
