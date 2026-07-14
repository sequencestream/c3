/**
 * Workcenter Dashboard snapshot + bulk automation-gate handler.
 *
 * Layers under test:
 *  1. `getWorkspaceDashboardHandler` — one live, time-range-independent row per
 *     workspace: `sessions.total` counts EVERY `SessionKind` (bound=1), `running`
 *     is the de-duplicated union of non-idle runtimes and automation sessions with
 *     a running execution log, and each domain total ignores status/time. A db /
 *     single-workspace failure yields a structured `dashboard.loadFailed` error,
 *     never all-zero rows. The gate defaults to `true` when unset.
 *  2. `setWorkspacesAutomationEnabledHandler` — admin-only bulk gate write settled
 *     per workspace: full-success, non-admin wholesale rejection, empty selection,
 *     duplicate ids, a workspace removed mid-batch, a partial persistence failure,
 *     and the invariant that only `automationEnabled` changes (other setting fields
 *     and automation rows are untouched).
 *
 * Rows are seeded with explicit SQL so the columns are fully deterministic;
 * `state.js`, `kernel/config` and `auth/authz` are mocked so the handler walks a
 * fixed workspace set with controllable gate / admin state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb, resetDbForTests, type Db } from '../../kernel/infra/db.js'
import * as intentsStore from '../intents/store.js'
import * as discussionsStore from '../discussions/store.js'
import * as automationsStore from '../automations/store.js'
import * as wsStore from '../works/work-session-store.js'
import type { WorkspaceSetting } from '@ccc/shared/protocol'
import { ensureRuntime, setStatus, removeRuntimesForWorkspace } from '../../runs.js'

const A = '/abs/proj-a'
const B = '/abs/proj-b'

// `state.js` mocked to a fixed set; ids are identity paths.
const hoisted = vi.hoisted(() => ({
  workspaces: [] as { id: string; name: string; path: string; lastAccessed: number }[],
  unresolvable: new Set<string>(),
}))
vi.mock('../../state.js', () => ({
  listWorkspaces: () => hoisted.workspaces,
  resolveWorkspaceRoot: (id: string) => (hoisted.unresolvable.has(id) ? undefined : id),
  pathToId: (p: string) => p,
}))

// `kernel/config` partially mocked: real exports kept (getTimezone etc.), only the
// gate/setting IO overridden so tests control gate state and capture writes.
const cfg = vi.hoisted(() => ({
  gate: new Map<string, boolean>(),
  settings: new Map<string, WorkspaceSetting>(),
  saved: [] as { path: string; config: WorkspaceSetting }[],
  saveThrowsFor: new Set<string>(),
}))
vi.mock('../../kernel/config/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../../kernel/config/index.js')>()
  return {
    ...actual,
    getAutomationEnabled: (p: string) => cfg.gate.get(p) ?? true,
    loadWorkspaceSetting: (p: string) => cfg.settings.get(p) ?? {},
    saveWorkspaceSetting: (p: string, config: WorkspaceSetting) => {
      if (cfg.saveThrowsFor.has(p)) throw new Error('disk full')
      cfg.saved.push({ path: p, config })
      cfg.settings.set(p, config)
    },
  }
})

// `auth/authz` mocked: requireAdmin gated by a flag; the real one sends an error
// frame on failure, which we replicate so the "non-admin" branch stays faithful.
const authz = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('../auth/authz.js', () => ({
  requireAdmin: (conn: { send: (m: unknown) => void }) => {
    if (authz.isAdmin) return true
    conn.send({ type: 'error', error: { code: 'auth.adminOnly' } })
    return false
  },
}))

import { getWorkspaceDashboardHandler, setWorkspacesAutomationEnabledHandler } from './index.js'
import type { WorkspaceDashboardRow, WorkspaceAutomationGateResult } from '@ccc/shared/protocol'

let dir: string
const T = 1_700_000_000_000

function d(): Db {
  const db = getDb()
  if (!db) throw new Error('db unavailable in test')
  return db
}

function warmSchema(): void {
  intentsStore.countByStatusInRange('/warm')
  discussionsStore.countByStatusInRange('/warm')
  automationsStore.countAutomationsInRange('/warm')
  wsStore.countRealInRange('/warm')
}

function seedIntent(proj: string, status: string): void {
  d().run(
    `INSERT INTO intents (id, workspace_path, title, content, priority, status, module, last_work_session_id, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    proj,
    't',
    '',
    'medium',
    status,
    '',
    null,
    T,
    T,
    null,
  )
}

function seedDiscussion(proj: string, status: string): void {
  d().run(
    `INSERT INTO discussions (id, workspace_path, title, type, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    randomUUID(),
    proj,
    't',
    'brainstorm',
    status,
    T,
    T,
  )
}

function seedAutomation(proj: string, status: string): string {
  const id = randomUUID()
  d().run(
    `INSERT INTO automations (id, type, workspace_path, cron_expression, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    'command',
    proj,
    '*/5 * * * *',
    status,
    T,
    T,
  )
  return id
}

function seedExecLog(automationId: string, status: string, sessionId: string | null): void {
  d().run(
    `INSERT INTO automation_execution_logs (id, automation_id, started_at, status, session_id)
     VALUES (?,?,?,?,?)`,
    randomUUID(),
    automationId,
    T,
    status,
    sessionId,
  )
}

/** A real (bound) session projection of any kind, optionally an automation owner. */
function seedSession(
  proj: string,
  sessionKind: string,
  opts: { vendorSessionId?: string; ownerKind?: string; ownerId?: string; bound?: number } = {},
): void {
  d().run(
    `INSERT INTO session_metadata (
       c3_id, workspace_path, vendor, vendor_session_id, agent_id, title, last_modified, state,
       state_updated_at, kind, session_kind, owner_kind, owner_id, bound
     )
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),
    proj,
    'claude',
    opts.vendorSessionId ?? null,
    'a',
    't',
    T,
    'alive',
    T,
    'real',
    sessionKind,
    opts.ownerKind ?? null,
    opts.ownerId ?? null,
    opts.bound ?? 1,
  )
}

function fakeConn() {
  return { send: vi.fn() } as never
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-dash-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  intentsStore.resetStoreForTests()
  discussionsStore.resetStoreForTests()
  automationsStore.resetStoreForTests()
  wsStore.resetStoreForTests()
  hoisted.workspaces = []
  hoisted.unresolvable.clear()
  cfg.gate.clear()
  cfg.settings.clear()
  cfg.saved.length = 0
  cfg.saveThrowsFor.clear()
  authz.isAdmin = true
})

afterEach(() => {
  removeRuntimesForWorkspace(A)
  removeRuntimesForWorkspace(B)
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function runDashboard(): { rows: WorkspaceDashboardRow[]; error?: { code: string } } {
  const conn = fakeConn()
  getWorkspaceDashboardHandler({} as never, conn, { type: 'get_workspace_dashboard' })
  const c = conn as unknown as { send: ReturnType<typeof vi.fn> }
  expect(c.send).toHaveBeenCalledTimes(1)
  const msg = c.send.mock.calls[0][0]
  expect(msg.type).toBe('workspace_dashboard')
  return msg
}

describe('getWorkspaceDashboardHandler — aggregation', () => {
  it('returns one row per registered workspace, in registry order, with opaque ids', () => {
    warmSchema()
    hoisted.workspaces = [
      { id: A, name: 'proj-a', path: A, lastAccessed: 2 },
      { id: B, name: 'proj-b', path: B, lastAccessed: 1 },
    ]
    const { rows, error } = runDashboard()
    expect(error).toBeUndefined()
    expect(rows.map((r) => r.workspaceId)).toEqual([A, B])
    expect(rows[0]).toMatchObject({ name: 'proj-a', path: A })
  })

  it('counts session total across EVERY SessionKind (bound=1), excluding pending rows', () => {
    warmSchema()
    for (const k of ['work', 'intent', 'spec', 'discussion', 'automation', 'tool']) {
      seedSession(A, k)
    }
    seedSession(A, 'work', { bound: 0 }) // pending placeholder — not counted
    hoisted.workspaces = [{ id: A, name: 'proj-a', path: A, lastAccessed: 1 }]
    const { rows } = runDashboard()
    expect(rows[0].sessions.total).toBe(6)
  })

  it('running = union of non-idle runtimes and automation running-log sessions, de-duped', () => {
    warmSchema()
    // A live work runtime.
    ensureRuntime('w1', A, 'default', [])
    setStatus('w1', 'running')
    // An idle runtime — excluded.
    ensureRuntime('w-idle', A, 'default', [])
    // An automation session backed by BOTH a runtime and a running log → counts once.
    const a1 = seedAutomation(A, 'active')
    seedSession(A, 'automation', {
      vendorSessionId: 'auto-1',
      ownerKind: 'automation',
      ownerId: a1,
    })
    seedExecLog(a1, 'running', 'auto-1')
    ensureRuntime('auto-1', A, 'default', [])
    setStatus('auto-1', 'running')
    // A command automation session with a running log but NO runtime → +1.
    const a2 = seedAutomation(A, 'active')
    seedSession(A, 'automation', {
      vendorSessionId: 'auto-2',
      ownerKind: 'automation',
      ownerId: a2,
    })
    seedExecLog(a2, 'running', 'auto-2')
    // A settled automation log → excluded.
    const a3 = seedAutomation(A, 'active')
    seedSession(A, 'automation', {
      vendorSessionId: 'auto-3',
      ownerKind: 'automation',
      ownerId: a3,
    })
    seedExecLog(a3, 'success', 'auto-3')
    hoisted.workspaces = [{ id: A, name: 'proj-a', path: A, lastAccessed: 1 }]
    const { rows } = runDashboard()
    // w1 + auto-1 (deduped) + auto-2 = 3
    expect(rows[0].sessions.running).toBe(3)
  })

  it('domain totals ignore status and time (raw table row counts)', () => {
    warmSchema()
    seedIntent(A, 'todo')
    seedIntent(A, 'done')
    seedIntent(A, 'cancelled')
    seedDiscussion(A, 'in_progress')
    seedDiscussion(A, 'completed')
    seedAutomation(A, 'active')
    seedAutomation(A, 'paused')
    hoisted.workspaces = [{ id: A, name: 'proj-a', path: A, lastAccessed: 1 }]
    const { rows } = runDashboard()
    expect(rows[0]).toMatchObject({
      intents: { total: 3 },
      discussions: { total: 2 },
      automations: { total: 2 },
    })
  })

  it('normalizes the gate: unset ⇒ true; explicit false ⇒ closed', () => {
    warmSchema()
    cfg.gate.set(B, false)
    hoisted.workspaces = [
      { id: A, name: 'proj-a', path: A, lastAccessed: 2 },
      { id: B, name: 'proj-b', path: B, lastAccessed: 1 },
    ]
    const { rows } = runDashboard()
    expect(rows.find((r) => r.workspaceId === A)!.automationEnabled).toBe(true)
    expect(rows.find((r) => r.workspaceId === B)!.automationEnabled).toBe(false)
  })

  it('empty registry ⇒ empty rows, not an error', () => {
    warmSchema()
    hoisted.workspaces = []
    const { rows, error } = runDashboard()
    expect(error).toBeUndefined()
    expect(rows).toEqual([])
  })

  it('db unavailable ⇒ structured error, not all-zero rows', () => {
    resetDbForTests()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'
    hoisted.workspaces = [{ id: A, name: 'proj-a', path: A, lastAccessed: 1 }]
    const { rows, error } = runDashboard()
    expect(rows).toEqual([])
    expect(error).toEqual({ code: 'dashboard.loadFailed' })
  })

  it('a single workspace failing to resolve ⇒ whole-snapshot structured error', () => {
    warmSchema()
    hoisted.unresolvable.add(B)
    hoisted.workspaces = [
      { id: A, name: 'proj-a', path: A, lastAccessed: 2 },
      { id: B, name: 'proj-b', path: B, lastAccessed: 1 },
    ]
    const { rows, error } = runDashboard()
    expect(rows).toEqual([])
    expect(error).toEqual({ code: 'dashboard.loadFailed' })
  })
})

describe('setWorkspacesAutomationEnabledHandler — bulk gate', () => {
  function run(msg: { workspaceIds: string[]; enabled: boolean }): {
    results: WorkspaceAutomationGateResult[]
    dashboard: WorkspaceDashboardRow[]
    dashboardError?: { code: string }
    errorFrame?: unknown
  } {
    const conn = fakeConn()
    setWorkspacesAutomationEnabledHandler({} as never, conn, {
      type: 'set_workspaces_automation_enabled',
      ...msg,
    })
    const c = conn as unknown as { send: ReturnType<typeof vi.fn> }
    const sent = c.send.mock.calls.map((call) => call[0])
    const result = sent.find((m) => m.type === 'workspaces_automation_result')
    const errorFrame = sent.find((m) => m.type === 'error')
    return { ...(result ?? { results: [], dashboard: [] }), errorFrame }
  }

  it('admin: all workspaces succeed and only automationEnabled changes', () => {
    warmSchema()
    cfg.settings.set(A, { forge: 'github', devSkill: '/plan', automationEnabled: true })
    cfg.settings.set(B, { maxRoundsPerStage: 12, automationEnabled: true })
    // A real automation row to prove the gate write never touches automations.
    const autoId = seedAutomation(A, 'paused')
    hoisted.workspaces = [
      { id: A, name: 'proj-a', path: A, lastAccessed: 2 },
      { id: B, name: 'proj-b', path: B, lastAccessed: 1 },
    ]
    const { results, dashboard, dashboardError } = run({ workspaceIds: [A, B], enabled: false })
    expect(results).toEqual([
      { workspaceId: A, ok: true },
      { workspaceId: B, ok: true },
    ])
    expect(dashboardError).toBeUndefined()
    expect(dashboard).toHaveLength(2)
    // Only the gate flipped; sibling fields preserved.
    expect(cfg.settings.get(A)).toEqual({
      forge: 'github',
      devSkill: '/plan',
      automationEnabled: false,
    })
    expect(cfg.settings.get(B)).toEqual({ maxRoundsPerStage: 12, automationEnabled: false })
    // The automation row's own status is untouched.
    const row = d().get<{ status: string }>('SELECT status FROM automations WHERE id=?', autoId)
    expect(row?.status).toBe('paused')
  })

  it('non-admin: whole batch rejected with an error frame, no writes', () => {
    warmSchema()
    authz.isAdmin = false
    cfg.settings.set(A, { automationEnabled: true })
    hoisted.workspaces = [{ id: A, name: 'proj-a', path: A, lastAccessed: 1 }]
    const { results, errorFrame } = run({ workspaceIds: [A], enabled: false })
    expect(errorFrame).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
    expect(results).toEqual([]) // no result frame at all
    expect(cfg.saved).toEqual([]) // nothing persisted
  })

  it('empty selection is a no-op (never "all workspaces")', () => {
    warmSchema()
    hoisted.workspaces = [{ id: A, name: 'proj-a', path: A, lastAccessed: 1 }]
    const { results } = run({ workspaceIds: [], enabled: false })
    expect(results).toEqual([])
    expect(cfg.saved).toEqual([])
  })

  it('de-duplicates repeated ids to a single write + single result', () => {
    warmSchema()
    cfg.settings.set(A, { automationEnabled: true })
    hoisted.workspaces = [{ id: A, name: 'proj-a', path: A, lastAccessed: 1 }]
    const { results } = run({ workspaceIds: [A, A, A], enabled: false })
    expect(results).toEqual([{ workspaceId: A, ok: true }])
    expect(cfg.saved.filter((s) => s.path === A)).toHaveLength(1)
  })

  it('a workspace removed mid-batch is a structured per-item failure, others proceed', () => {
    warmSchema()
    cfg.settings.set(A, { automationEnabled: true })
    hoisted.unresolvable.add(B) // B was removed before the write
    hoisted.workspaces = [{ id: A, name: 'proj-a', path: A, lastAccessed: 1 }]
    const { results } = run({ workspaceIds: [A, B], enabled: false })
    expect(results).toEqual([
      { workspaceId: A, ok: true },
      { workspaceId: B, ok: false, error: { code: 'dashboard.workspaceMissing' } },
    ])
  })

  it('a partial persistence failure keeps successes and reports the failed item', () => {
    warmSchema()
    cfg.settings.set(A, { automationEnabled: true })
    cfg.settings.set(B, { automationEnabled: true })
    cfg.saveThrowsFor.add(B)
    hoisted.workspaces = [
      { id: A, name: 'proj-a', path: A, lastAccessed: 2 },
      { id: B, name: 'proj-b', path: B, lastAccessed: 1 },
    ]
    const { results } = run({ workspaceIds: [A, B], enabled: false })
    expect(results).toEqual([
      { workspaceId: A, ok: true },
      { workspaceId: B, ok: false, error: { code: 'dashboard.gateSaveFailed' } },
    ])
    expect(cfg.settings.get(A)!.automationEnabled).toBe(false) // A still committed
  })
})
