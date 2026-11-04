import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionMetadataRow } from '../sessions/session-metadata-store.js'

const stub = vi.hoisted(() => ({
  home: '',
  rows: [] as SessionMetadataRow[],
  days: {} as Record<string, number>,
  running: new Set<string>(),
  automationActive: new Set<string>(),
  onRecheck: undefined as (() => void) | undefined,
  activity: {} as Record<string, number>,
  registered: ['/workspace/a', '/workspace/b'],
  remove: vi.fn(),
  removeConfig: vi.fn(),
  removeChat: vi.fn(),
  removeTool: vi.fn(),
  removeRuntime: vi.fn(),
}))
vi.mock('../../kernel/config/index.js', () => ({
  loadWorkspaceSetting: (path: string) => ({ sessionRetentionDays: stub.days[path] ?? 15 }),
  deleteSessionAgentId: stub.removeConfig,
}))
vi.mock('../../kernel/config/workspace-path.js', () => ({
  hostClaudeConfigDir: () => join(stub.home, 'claude'),
  hostCodexHome: () => join(stub.home, 'codex'),
  relayCodexHome: () => join(stub.home, 'relay', 'codex'),
}))
vi.mock('../../kernel/config/workspace-store.js', () => ({
  listWorkspaceRows: () => stub.registered.map((path) => ({ path })),
}))
vi.mock('../sessions/session-metadata-store.js', () => ({
  listAll: () => stub.rows,
  getByC3Id: (id: string) => {
    stub.onRecheck?.()
    return stub.rows.find((row) => row.c3Id === id)
  },
  deleteByVendorId: stub.remove,
}))
vi.mock('../intents/store.js', () => ({
  deleteChatSession: stub.removeChat,
  deleteToolSessionRecord: stub.removeTool,
}))
vi.mock('../works/active-workspace-sessions.js', () => ({
  listActiveSessionsForWorkspace: () =>
    [...stub.automationActive].map((sessionId) => ({ sessionId })),
}))
vi.mock('../../runs.js', () => ({
  isRunning: (id: string) => stub.running.has(id),
  sessionLastActivityAt: (id: string) => stub.activity[id] ?? null,
  removeRuntime: stub.removeRuntime,
}))
vi.mock('../../state.js', () => ({
  deleteSessionMode: vi.fn(),
  deleteSessionCodexPolicy: vi.fn(),
  getActiveSessionId: () => null,
  setActiveSessionId: vi.fn(),
}))

import {
  runWorkspaceSessionPruneOnce,
  startWorkspaceSessionJanitor,
  stopWorkspaceSessionJanitor,
} from './workspace-session-janitor.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const CODEX_ID = '12345678-1234-1234-1234-123456789abc'

function row(
  id: string,
  age = 16,
  overrides: Partial<SessionMetadataRow> = {},
): SessionMetadataRow {
  return {
    c3Id: `c3s_${id}` as SessionMetadataRow['c3Id'],
    workspacePath: '/workspace/a',
    vendor: 'claude',
    vendorSessionId: id,
    agentId: 'agent',
    title: id,
    lastModified: NOW - age * DAY,
    state: 'alive',
    stateUpdatedAt: NOW,
    kind: 'real',
    bound: true,
    sessionKind: 'automation',
    ownerKind: 'automation',
    ownerId: 'task',
    ...overrides,
  }
}

function file(relative: string, age = 16): string {
  const path = join(stub.home, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '{}')
  const time = (NOW - age * DAY) / 1000
  utimesSync(path, time, time)
  return path
}

beforeEach(() => {
  stub.home = mkdtempSync(join(tmpdir(), 'c3-workspace-prune-'))
  stub.rows = []
  stub.days = {}
  stub.running.clear()
  stub.automationActive.clear()
  stub.onRecheck = undefined
  stub.activity = {}
  vi.clearAllMocks()
})
afterEach(() => {
  stopWorkspaceSessionJanitor()
  vi.useRealTimers()
  rmSync(stub.home, { recursive: true, force: true })
})

describe('workspace session cleanup', () => {
  it('uses each workspace retention and preserves the exact boundary and untracked sessions', async () => {
    stub.days['/workspace/b'] = 30
    stub.rows = [
      row('expired'),
      row('boundary', 15),
      row('other', 20, { workspacePath: '/workspace/b' }),
    ]
    const expired = file('claude/projects/a/expired.jsonl')
    const boundary = file('claude/projects/a/boundary.jsonl', 15)
    const other = file('claude/projects/b/other.jsonl', 20)
    const external = file('claude/projects/a/external.jsonl', 100)
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(1)
    expect(existsSync(expired)).toBe(false)
    for (const path of [boundary, other, external]) expect(existsSync(path)).toBe(true)
    expect(stub.remove).toHaveBeenCalledTimes(1)
    expect(stub.remove).toHaveBeenCalledWith('claude', 'expired')
    expect(stub.removeChat).toHaveBeenCalledWith('/workspace/a', 'expired')
    expect(stub.removeConfig).toHaveBeenCalledWith('expired')
    expect(stub.removeRuntime).toHaveBeenCalledWith('expired')
  })

  it('protects running sessions, recent runtime activity, and newer native writes', async () => {
    stub.rows = [row('running'), row('active'), row('native')]
    stub.running.add('running')
    stub.activity.active = NOW - DAY
    const paths = [
      file('claude/projects/a/running.jsonl'),
      file('claude/projects/a/active.jsonl'),
      file('claude/projects/a/native.jsonl', 1),
    ]
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(0)
    for (const path of paths) expect(existsSync(path)).toBe(true)
    expect(stub.remove).not.toHaveBeenCalled()
  })

  it('removes expired Codex transcripts in both homes and Claude subagent transcripts', async () => {
    stub.rows = [row(CODEX_ID, 16, { vendor: 'codex' }), row('parent')]
    const paths = [
      file(`codex/sessions/2026/01/01/rollout-time-${CODEX_ID}.jsonl`),
      file(`relay/codex/sessions/2026/01/01/rollout-time-${CODEX_ID}.jsonl`),
      file('claude/projects/a/parent.jsonl'),
      file('claude/projects/a/parent/subagents/agent-abc.jsonl'),
    ]
    const config = file('codex/config.toml', 100)
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(2)
    for (const path of paths) expect(existsSync(path)).toBe(false)
    expect(existsSync(config)).toBe(true)
  })

  it('keeps the parent when a subagent transcript is recent', async () => {
    stub.rows = [row('parent')]
    const parent = file('claude/projects/a/parent.jsonl')
    file('claude/projects/a/parent/subagents/agent-abc.jsonl', 1)
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(0)
    expect(existsSync(parent)).toBe(true)
  })

  it('skips unbound, Cursor, and unregistered workspace sessions', async () => {
    stub.rows = [
      row('pending', 100, { bound: false }),
      row('cursor', 100, { vendor: 'cursor' }),
      row('removed', 100, { workspacePath: '/unregistered' }),
    ]
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(0)
    expect(stub.remove).not.toHaveBeenCalled()
  })

  it('reclaims expired metadata whose transcript is already missing', async () => {
    stub.rows = [row('missing')]
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(1)
    expect(stub.remove).toHaveBeenCalledWith('claude', 'missing')
  })

  it('preserves metadata on scan failure while processing another vendor', async () => {
    stub.rows = [row('claude'), row(CODEX_ID, 16, { vendor: 'codex' })]
    file('claude/projects') // a file rather than a readable transcript directory
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(1)
    expect(stub.remove).toHaveBeenCalledTimes(1)
    expect(stub.remove).toHaveBeenCalledWith('codex', CODEX_ID)
  })

  it('continues after a failed session deletion', async () => {
    stub.rows = [row('fail'), row('ok')]
    stub.removeChat.mockImplementationOnce(() => {
      throw new Error('db busy')
    })
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(1)
    expect(stub.remove).toHaveBeenCalledTimes(1)
    expect(stub.remove).toHaveBeenCalledWith('claude', 'ok')
  })

  it('protects active automation executions even without a runtime run handle', async () => {
    stub.rows = [row('log-running')]
    stub.automationActive.add('log-running')
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(0)
    expect(stub.remove).not.toHaveBeenCalled()
  })

  it('rechecks a resumed session after asynchronous scanning', async () => {
    stub.rows = [row('resumed')]
    const path = file('claude/projects/a/resumed.jsonl')
    stub.onRecheck = () => {
      stub.running.add('resumed')
    }
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(0)
    expect(existsSync(path)).toBe(true)
  })

  it('uses a retention extension saved during the scan', async () => {
    stub.rows = [row('extended')]
    const path = file('claude/projects/a/extended.jsonl')
    stub.onRecheck = () => {
      stub.days['/workspace/a'] = 30
    }
    expect(await runWorkspaceSessionPruneOnce({ now: NOW })).toBe(0)
    expect(existsSync(path)).toBe(true)
  })

  it('starts only one timer, runs daily and stops cleanly', async () => {
    vi.useFakeTimers()
    startWorkspaceSessionJanitor()
    startWorkspaceSessionJanitor()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(DAY)
    expect(vi.getTimerCount()).toBe(1)
    stopWorkspaceSessionJanitor()
    expect(vi.getTimerCount()).toBe(0)
  })
})
