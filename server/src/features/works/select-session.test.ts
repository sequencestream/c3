/**
 * `select_session` handler branch contract.
 *
 * A normal Claude select cold-loads history (`sessionTitle`/`loadHistory`), while
 * Codex projection placeholders fall back to the legacy title path.
 * The IO-heavy collaborators are mocked; we assert the handler's branch contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../runs.js', () => ({
  addViewer: vi.fn(),
  emit: vi.fn(),
  ensureRuntime: vi.fn(
    (_id: string, _workspacePath: string, mode: string, baseline: unknown[] = []) => ({
      mode,
      baseline,
      status: 'idle',
      buffer: [],
    }),
  ),
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
  // Identity stubs: the test passes a path as the workspaceId, so resolve/pathToId
  // round-trip it back to the same value (the workspace is "registered").
  resolveWorkspaceRoot: vi.fn((id: string) => id),
  pathToId: vi.fn((p: string) => p),
  setActiveSessionId: vi.fn(),
  setSessionMode: vi.fn(),
  touchWorkspace: vi.fn(),
}))
vi.mock('../sessions/session-metadata-store.js', () => ({
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
vi.mock('../intents/store.js', () => ({ findIntentIdBySessionId: vi.fn(() => null) }))

import { selectSession } from './index.js'
import { loadHistory, sessionTitle } from '../../sessions.js'
import { resolveSessionVendor } from '../../kernel/agent-config/index.js'
import { getByC3Id } from '../sessions/session-metadata-store.js'
import { findIntentIdBySessionId } from '../intents/store.js'
import { CodexSessionStore } from '../../kernel/agent/adapters/codex/index.js'

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
  it('normal Claude select → cold-loads history', async () => {
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspaceId: '/abs/proj',
      sessionId: 'claude-1',
    })
    expect(loadHistory).toHaveBeenCalledWith('/abs/proj', 'claude-1')
    expect(sessionTitle).toHaveBeenCalled()
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.vendor).toBe('claude')
  })

  it('codex select → uses the projection title (same-source as the list), not the claude-only legacy path', async () => {
    // Regression: codex never resolves through `sessionTitle` (claude-only), so
    // the title bar showed "Untitled session". Projection-first fixes it — the
    // run-end-derived title in `session_metadata` is the same source the
    // session list reads.
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')
    vi.mocked(getByC3Id).mockReturnValue({ title: 'Refactor the parser' } as never)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspaceId: '/abs/proj',
      sessionId: 'codex-thread-1',
    })
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.title).toBe('Refactor the parser')
    // Projection hit ⇒ the legacy claude-only lookup is short-circuited.
    expect(sessionTitle).not.toHaveBeenCalled()
  })

  it('codex select → replays codex JSONL history instead of claude-only history', async () => {
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')
    vi.mocked(getByC3Id).mockReturnValue({ title: 'Fix the login bug' } as never)
    const readSpy = vi.spyOn(CodexSessionStore.prototype, 'read').mockResolvedValue([
      {
        vendor: 'codex',
        sessionId: 'codex-thread-history',
        role: 'user',
        blocks: [{ type: 'text', id: 'u1', text: 'Fix the login bug' }],
        ts: 1,
      },
      {
        vendor: 'codex',
        sessionId: 'codex-thread-history',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            id: 'cmd-1',
            name: 'shell',
            input: { command: 'pnpm test' },
            result: { content: 'ok', isError: false },
          },
        ],
        ts: 2,
        preApproved: true,
      },
    ])
    const conn = fakeConn()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspaceId: '/abs/proj',
      sessionId: 'codex-thread-history',
    })

    expect(loadHistory).not.toHaveBeenCalled()
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.history).toEqual([
      { kind: 'user', text: 'Fix the login bug' },
      { kind: 'tool_use', toolUseId: 'cmd-1', toolName: 'shell', input: { command: 'pnpm test' } },
      { kind: 'tool_result', toolUseId: 'cmd-1', content: 'ok', isError: false },
    ])
    readSpy.mockRestore()
  })

  it('codex select with only a placeholder in the projection → falls back to the legacy path', async () => {
    vi.mocked(resolveSessionVendor).mockReturnValue('codex')
    vi.mocked(getByC3Id).mockReturnValue({ title: 'New session' } as never)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspaceId: '/abs/proj',
      sessionId: 'codex-thread-2',
    })
    // Placeholder is not adopted ⇒ legacy lookup runs (returns its own value).
    expect(sessionTitle).toHaveBeenCalled()
  })

  it('intent-bound session → session_selected carries the reverse-looked-up linkedIntentId', async () => {
    vi.mocked(findIntentIdBySessionId).mockReturnValue('intent-xyz')
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspaceId: '/abs/proj',
      sessionId: 'dev-sess-1',
    })
    expect(findIntentIdBySessionId).toHaveBeenCalledWith('dev-sess-1')
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.linkedIntentId).toBe('intent-xyz')
  })

  it('plain session (no intent_sessions row) → linkedIntentId is absent', async () => {
    vi.mocked(findIntentIdBySessionId).mockReturnValue(null)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspaceId: '/abs/proj',
      sessionId: 'plain-1',
    })
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.linkedIntentId).toBeUndefined()
  })

  it('projection-owned automation session → session_selected carries owner metadata', async () => {
    vi.mocked(getByC3Id).mockReturnValue({
      title: 'Automation: Nightly review',
      sessionKind: 'automation',
      ownerKind: 'automation',
      ownerId: 'automation-1',
    } as never)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await selectSession({} as any, conn as any, {
      type: 'select_session',
      workspaceId: '/abs/proj',
      sessionId: 'automation-session-1',
    })
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel?.sessionKind).toBe('automation')
    expect(sel?.ownerKind).toBe('automation')
    expect(sel?.ownerId).toBe('automation-1')
  })
})
