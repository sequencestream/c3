/**
 * Cursor `create_session` seeds mode from workspace `defaultMode.cursor`
 * (catalog-gated). Without vendor-aware seeding / normalize keeping the
 * cursor key, session_selected.mode was Claude `'default'` → empty title bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  pathToId: vi.fn((p: string) => p),
  touchWorkspace: vi.fn(),
}))

import { createSession } from './index.js'
import {
  loadSettings,
  resetSettingsCacheForTests,
  saveSettings,
  saveWorkspaceSetting,
} from '../../kernel/config/index.js'
import { systemAgent } from '../../kernel/agent-config/index.js'
import type { WorkspaceSetting } from '@ccc/shared/protocol'
import { ensureRuntime } from '../../runs.js'
import { getPendingIntent } from './work-session-store.js'

const PROJ = '/abs/cursor-mode-proj'

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-create-cursor-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
  saveSettings({
    ...loadSettings(),
    agents: [
      systemAgent(),
      {
        id: 'cursor-a',
        vendor: 'cursor',
        configMode: 'system',
        displayName: 'Cursor A',
        enabled: true,
        order_seq: 1,
        config: { apiKey: '', model: '' },
      },
    ],
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
  vi.clearAllMocks()
})

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

describe('create_session Cursor defaultMode seeding', () => {
  it('respects a legal workspace defaultMode.cursor on session_selected and ensureRuntime', () => {
    expect(loadSettings().agents.some((a) => a.id === 'cursor-a' && a.vendor === 'cursor')).toBe(
      true,
    )
    saveWorkspaceSetting(PROJ, {
      defaultMode: { claude: 'default', codex: 'auto', cursor: 'full-access' },
    } as WorkspaceSetting)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, {
      type: 'create_session',
      workspaceId: PROJ,
      agentId: 'cursor-a',
    })
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(getPendingIntent(sel?.sessionId as string)?.agentId).toBe('cursor-a')
    // Mode is seeded from getDefaultMode(path, resolvedAgent.vendor) at create
    // time — independent of resolveSessionVendor (which needs the composition
    // pending-intent hook not wired in this unit test).
    expect(sel?.mode).toBe('full-access')
    expect(ensureRuntime).toHaveBeenCalledWith(
      sel?.sessionId,
      PROJ,
      'full-access',
      [],
      'work',
      undefined,
    )
  })

  it('falls back to cursor catalog defaultToken agent when workspace has no cursor default', () => {
    saveWorkspaceSetting(PROJ, {} as WorkspaceSetting)
    const conn = fakeConn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession({} as any, conn as any, {
      type: 'create_session',
      workspaceId: PROJ,
      agentId: 'cursor-a',
    })
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(getPendingIntent(sel?.sessionId as string)?.agentId).toBe('cursor-a')
    expect(sel?.mode).toBe('agent')
  })
})
