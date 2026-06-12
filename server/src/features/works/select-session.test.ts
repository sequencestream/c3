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
  getSessionCodexPolicy: vi.fn(() => null),
  hasWorkspace: vi.fn(() => true),
  setActiveSessionId: vi.fn(),
  setSessionMode: vi.fn(),
  touchWorkspace: vi.fn(),
}))
vi.mock('./work-session-store.js', () => ({
  upsertPendingRow: vi.fn(),
  getByC3Id: vi.fn(() => null),
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
import { getByC3Id } from './work-session-store.js'

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

  it('codex select → uses the projection title (same-source as the list), not the claude-only legacy path', async () => {
    // Regression: codex never resolves through `sessionTitle` (claude-only), so
    // the title bar showed "Untitled session". Projection-first fixes it — the
    // run-end-derived title in `work_session_metadata` is the same source the
    // session list reads.
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')
    vi.mocked(getByC3Id).mockReturnValue({ title: 'Refactor the parser' } as never)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspacePath: '/abs/proj',
      sessionId: 'codex-thread-1',
    })
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.title).toBe('Refactor the parser')
    // Projection hit ⇒ the legacy claude-only lookup is short-circuited.
    expect(sessionTitle).not.toHaveBeenCalled()
  })

  it('codex select with only a placeholder in the projection → falls back to the legacy path', async () => {
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')
    vi.mocked(getByC3Id).mockReturnValue({ title: 'New session' } as never)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspacePath: '/abs/proj',
      sessionId: 'codex-thread-2',
    })
    // Placeholder is not adopted ⇒ legacy lookup runs (returns its own value).
    expect(sessionTitle).toHaveBeenCalled()
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
