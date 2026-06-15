/**
 * Tests for the `work_session_metadata` projection store (F-2..F-12, the column
 * whitelist, fail-soft, and the lifecycle state machine). Mirrors the
 * pattern of `features/discussions/store.test.ts`: temp-dir c3.db per test
 * via `C3_DB_PATH`, `resetDbForTests` + `resetStoreForTests` in setup/teardown.
 *
 * The test surface follows the spec's Done contract: every acceptance
 * criterion becomes at least one test, with a one-line comment per test
 * saying which AC it pins. A `setNow` clock injection drives the janitor
 * tests deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { mintC3SessionId } from '../../kernel/agent/session/accessor.js'
import {
  JANITOR_INTERVAL_MS,
  LAZY_VALIDATE_MS,
  STALE_MS,
  assertColumnWhitelist,
  columnWhitelist,
  deleteByPendingId,
  deleteByVendorId,
  getByC3Id,
  getPendingIntent,
  isStoreAvailable,
  janitor,
  listAll,
  listForWorkspace,
  rebuildOne,
  resetStoreForTests,
  setNow,
  touchOnRunEnd,
  updatePendingRowAgentId,
  updateRealRowAgentId,
  updateRealRowTitle,
  upsertForBind,
  upsertPendingRow,
  validateLazy,
  type NativeListFn,
} from './work-session-store.js'

let dir: string
let nowMs = 1_000_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sm-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  nowMs = 1_000_000
  setNow(() => nowMs)
})

afterEach(() => {
  resetDbForTests()
  resetStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

const wsA = '/abs/proj-A'
const wsB = '/abs/proj-B'
const agent1 = 'agent-claude-1'
const agent2 = 'agent-claude-2'
const codexAgent = 'agent-codex-1'

describe('schema (F-12 column whitelist)', () => {
  it("assertColumnWhitelist returns exactly the spec'd column set", () => {
    // F-12: the projection table holds ONLY the spec'd columns. Touching the
    // SCHEMA without touching the whitelist (or vice versa) fails this test.
    expect(isStoreAvailable()).toBe(true)
    listAll() // ensure schema
    const cols = assertColumnWhitelist().map((c) => c.name)
    expect(cols.sort()).toEqual([...columnWhitelist()].sort())
  })

  it('columnWhitelist is the canonical 10-column set', () => {
    expect([...columnWhitelist()].sort()).toEqual(
      [
        'c3_id',
        'workspace_path',
        'vendor',
        'vendor_session_id',
        'agent_id',
        'title',
        'last_modified',
        'state',
        'state_updated_at',
        'kind',
      ].sort(),
    )
  })

  it('does NOT include any content-shaped column', () => {
    // Negative form of F-12: the column set must not contain any
    // transcript/prompt/tool_use/tool_result/content column.
    const cols = assertColumnWhitelist().map((c) => c.name)
    for (const banned of [
      'content',
      'transcript',
      'messages',
      'tool_use',
      'tool_result',
      'prompt',
      'blocks',
      'blocks_json',
    ]) {
      expect(cols).not.toContain(banned)
    }
  })
})

describe('createSession pending row (F-11 replacement for setPendingIntent)', () => {
  it("writes a pending row with the agent's vendor", () => {
    // F-11: the pending intent moves from state.json into the projection as a
    // row variant. The new home for what setPendingIntent used to carry.
    upsertPendingRow({
      pendingId: 'pending:abc',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    const row = getByC3Id('pending:abc')
    expect(row?.kind).toBe('pending')
    expect(row?.vendor).toBe('claude')
    expect(row?.agentId).toBe(agent1)
    expect(row?.workspacePath).toBe(wsA)
    expect(row?.vendorSessionId).toBeNull()
    expect(row?.lastModified).toBeNull()
    expect(row?.state).toBe('born')
  })

  it('updatePendingRowAgentId rewrites the agent (F-6 pending re-target)', () => {
    // F-6 pending branch: the UI set_session_agent on a still-pending
    // session updates the projection's pending row.
    upsertPendingRow({
      pendingId: 'pending:abc',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    updatePendingRowAgentId({ pendingId: 'pending:abc', vendor: 'claude', agentId: agent2 })
    expect(getByC3Id('pending:abc')?.agentId).toBe(agent2)
  })
})

describe('upsertForBind (F-5)', () => {
  it('drops the pending row and inserts a real row in one transaction', () => {
    // F-5: the bind hookup is a single entry point (called from BOTH run
    // paths via freezeSessionAgent). Atomically drops the pending row.
    upsertPendingRow({
      pendingId: 'pending:abc',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    upsertForBind({
      pendingId: 'pending:abc',
      realId: 'real-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    expect(getByC3Id('pending:abc')).toBeNull()
    const real = getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'real-1' }))
    expect(real?.kind).toBe('real')
    expect(real?.vendorSessionId).toBe('real-1')
    expect(real?.agentId).toBe(agent1)
    expect(real?.title).toBe('New session')
    // Bind stamps last_modified = bind time (now), so a freshly-bound session
    // sorts to the TOP of the list instead of sinking to the bottom (null).
    expect(real?.lastModified).toBe(nowMs)
  })

  it('a retry-bind of the same realId is a no-op (idempotence)', () => {
    // F-5: a retry-bind (run-lifecycle hasBound guard) must not double-upsert.
    upsertForBind({
      pendingId: 'pending:abc',
      realId: 'real-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    upsertForBind({
      pendingId: 'pending:abc',
      realId: 'real-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent2,
    })
    const real = getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'real-1' }))
    expect(real?.agentId).toBe(agent1)
  })

  it('Codex bind writes a real row with last_modified=bind time (F-7)', () => {
    // F-7: Codex is the canonical "already-ran but not enumerable" case.
    // The bound row appears in the projection; the next lazy validation
    // rewrites the title. last_modified is stamped to the bind time — Codex
    // is SKIPPED by lazy validation, so a null here would strand the row at
    // the bottom of the list forever; bind time keeps it sortable from the start.
    upsertForBind({
      pendingId: 'pending:codex-1',
      realId: 'codex-thread-1',
      workspacePath: wsA,
      vendor: 'codex',
      agentId: codexAgent,
    })
    const row = getByC3Id(mintC3SessionId({ vendor: 'codex', vendorSessionId: 'codex-thread-1' }))
    expect(row?.vendor).toBe('codex')
    expect(row?.lastModified).toBe(nowMs)
    expect(row?.state).toBe('born')
    expect(listForWorkspace(wsA).map((r) => r.vendorSessionId)).toEqual(['codex-thread-1'])
  })
})

describe('same-vendor agent swap (F-6)', () => {
  it('updateRealRowAgentId rewrites agent_id on the real row', () => {
    upsertForBind({
      pendingId: 'pending:abc',
      realId: 'real-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    updateRealRowAgentId('real-1', 'claude', agent2)
    const real = getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'real-1' }))
    expect(real?.agentId).toBe(agent2)
    expect(real?.state).toBe('alive')
  })
})

describe('rename (F-3) and delete (F-4)', () => {
  it('updateRealRowTitle rewrites the title', () => {
    upsertForBind({
      pendingId: 'pending:abc',
      realId: 'real-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    updateRealRowTitle('real-1', 'claude', 'New name')
    expect(getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'real-1' }))?.title).toBe(
      'New name',
    )
  })

  it('deleteByVendorId removes the row by c3 id', () => {
    upsertForBind({
      pendingId: 'pending:abc',
      realId: 'real-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    deleteByVendorId('claude', 'real-1')
    expect(getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'real-1' }))).toBeNull()
  })

  it('deleteByPendingId removes a pending row that never ran', () => {
    upsertPendingRow({
      pendingId: 'pending:abc',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    deleteByPendingId('pending:abc')
    expect(getByC3Id('pending:abc')).toBeNull()
  })
})

describe('run-end upsert (F-2, single trigger for both run paths)', () => {
  it('touchOnRunEnd updates title/lastModified/agent_id and flips state to alive', () => {
    upsertForBind({
      pendingId: 'pending:abc',
      realId: 'real-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    nowMs += 100
    touchOnRunEnd({
      realId: 'real-1',
      vendor: 'claude',
      agentId: agent1,
      title: 'After run',
      lastModified: 5_000_000,
    })
    const real = getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'real-1' }))
    expect(real?.title).toBe('After run')
    expect(real?.lastModified).toBe(5_000_000)
    expect(real?.state).toBe('alive')
  })
})

describe('listForWorkspace + cross-workspace isolation', () => {
  it('only returns rows in the requested workspace', () => {
    upsertForBind({
      pendingId: 'pending:1',
      realId: 'a-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    upsertForBind({
      pendingId: 'pending:2',
      realId: 'b-1',
      workspacePath: wsB,
      vendor: 'claude',
      agentId: agent1,
    })
    expect(listForWorkspace(wsA).map((r) => r.vendorSessionId)).toEqual(['a-1'])
    expect(listForWorkspace(wsB).map((r) => r.vendorSessionId)).toEqual(['b-1'])
  })

  it('excludes pending rows from the read path (only real rows are listed)', () => {
    upsertPendingRow({
      pendingId: 'pending:abc',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    expect(listForWorkspace(wsA)).toEqual([])
  })

  it('sorts newest-first by last_modified, with nulls at the end', () => {
    upsertForBind({
      pendingId: 'p1',
      realId: 'a-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    upsertForBind({
      pendingId: 'p2',
      realId: 'a-2',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    nowMs += 10
    touchOnRunEnd({
      realId: 'a-1',
      vendor: 'claude',
      agentId: agent1,
      title: 'a-1',
      lastModified: 100,
    })
    nowMs += 10
    touchOnRunEnd({
      realId: 'a-2',
      vendor: 'claude',
      agentId: agent1,
      title: 'a-2',
      lastModified: 200,
    })
    // A row whose last_modified is explicitly null (the column is nullable)
    // still sorts to the very end via `ORDER BY (last_modified IS NULL) …`.
    // Bind no longer produces null (it stamps bind time), so we force one here.
    upsertForBind({
      pendingId: 'p3',
      realId: 'a-3',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    touchOnRunEnd({
      realId: 'a-3',
      vendor: 'claude',
      agentId: agent1,
      title: 'a-3',
      lastModified: null,
    })
    expect(listForWorkspace(wsA).map((r) => r.vendorSessionId)).toEqual(['a-2', 'a-1', 'a-3'])
  })
})

describe('getPendingIntent (F-11 read-through)', () => {
  it('returns the agent id of a pending row', () => {
    upsertPendingRow({
      pendingId: 'pending:abc',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    expect(getPendingIntent('pending:abc')).toEqual({ agentId: agent1 })
  })
  it('returns null for an unknown pending id', () => {
    expect(getPendingIntent('pending:nope')).toBeNull()
  })
})

describe('C3SessionId de-dup', () => {
  it('same (vendor, vendorSessionId) always mints the same c3 id', () => {
    const a = mintC3SessionId({ vendor: 'claude', vendorSessionId: 'real-1' })
    const b = mintC3SessionId({ vendor: 'claude', vendorSessionId: 'real-1' })
    expect(a).toBe(b)
  })

  it('different vendors with the same id do NOT collide', () => {
    const claude = mintC3SessionId({ vendor: 'claude', vendorSessionId: 'shared' })
    const codex = mintC3SessionId({ vendor: 'codex', vendorSessionId: 'shared' })
    expect(claude).not.toBe(codex)
  })
})

describe('lazy validation (F-8)', () => {
  it('rewrites a row when the native title/lastModified differ', async () => {
    upsertForBind({
      pendingId: 'p1',
      realId: 'a-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    nowMs += 10
    touchOnRunEnd({
      realId: 'a-1',
      vendor: 'claude',
      agentId: agent1,
      title: 'old',
      lastModified: 100,
    })

    // Push the clock past LAZY_VALIDATE_MS.
    nowMs += LAZY_VALIDATE_MS + 1
    const nativeList: NativeListFn = async () => ({
      sessions: [{ vendorSessionId: 'a-1', title: 'rewritten', lastModified: 999 }],
    })
    const result = await validateLazy({ workspacePath: wsA, nativeList })
    expect(result.rewritten).toBe(1)
    expect(result.checked).toBe(1)
    const row = getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'a-1' }))
    expect(row?.title).toBe('rewritten')
    expect(row?.lastModified).toBe(999)
    expect(row?.state).toBe('alive')
  })

  it('flips a row to ghost when the native list errors', async () => {
    upsertForBind({
      pendingId: 'p1',
      realId: 'a-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    nowMs += 10
    touchOnRunEnd({ realId: 'a-1', vendor: 'claude', agentId: agent1, title: 't', lastModified: 1 })
    nowMs += LAZY_VALIDATE_MS + 1
    const result = await validateLazy({
      workspacePath: wsA,
      nativeList: async () => null,
    })
    expect(result.ghosted).toBe(1)
    expect(getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'a-1' }))?.state).toBe(
      'ghost',
    )
  })

  it('Codex rows are SKIPPED (the canonical lazy case)', async () => {
    upsertForBind({
      pendingId: 'p1',
      realId: 'a-1',
      workspacePath: wsA,
      vendor: 'codex',
      agentId: codexAgent,
    })
    nowMs += LAZY_VALIDATE_MS + 1
    const nativeList = vi.fn(async () => null)
    const result = await validateLazy({ workspacePath: wsA, nativeList })
    expect(result.skipped).toBe(1)
    expect(result.checked).toBe(0)
    expect(nativeList).not.toHaveBeenCalled()
  })
})

describe('janitor (F-9, with warmup)', () => {
  it('walks a row born → alive → stale → stale → orphaned over the right number of passes', async () => {
    upsertForBind({
      pendingId: 'p1',
      realId: 'a-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    nowMs += 10
    touchOnRunEnd({ realId: 'a-1', vendor: 'claude', agentId: agent1, title: 't', lastModified: 1 })

    // Pass 0: born, no observation needed.
    let r = await janitor({
      nativeList: async () => ({
        sessions: [{ vendorSessionId: 'a-1', title: 't', lastModified: 1 }],
      }),
      workspaces: [wsA],
    })
    expect(r.stale).toBe(0)

    // Push past STALE_MS and run a sweep — row should go `alive` → `stale`.
    nowMs += STALE_MS + 1
    r = await janitor({
      nativeList: async () => ({
        sessions: [{ vendorSessionId: 'a-1', title: 't', lastModified: 1 }],
      }),
      workspaces: [wsA],
    })
    expect(r.stale).toBe(1)
    expect(getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'a-1' }))?.state).toBe(
      'stale',
    )

    // Warmup pass: native no longer returns the row. Row should STAY `stale`
    // (single observation), not flip to `orphaned` yet.
    r = await janitor({
      nativeList: async () => ({ sessions: [] }),
      workspaces: [wsA],
    })
    expect(r.orphaned).toBe(0)
    expect(getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'a-1' }))?.state).toBe(
      'stale',
    )

    // Push past JANITOR_INTERVAL_MS; the second stale observation ⇒ `orphaned`.
    nowMs += JANITOR_INTERVAL_MS + 1
    r = await janitor({
      nativeList: async () => ({ sessions: [] }),
      workspaces: [wsA],
    })
    expect(r.orphaned).toBe(1)
    expect(getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'a-1' }))?.state).toBe(
      'orphaned',
    )
  })

  it('a successful native match refreshes a stale row back to alive', async () => {
    upsertForBind({
      pendingId: 'p1',
      realId: 'a-1',
      workspacePath: wsA,
      vendor: 'claude',
      agentId: agent1,
    })
    nowMs += 10
    touchOnRunEnd({ realId: 'a-1', vendor: 'claude', agentId: agent1, title: 't', lastModified: 1 })
    nowMs += STALE_MS + 1
    await janitor({
      nativeList: async () => ({ sessions: [] }),
      workspaces: [wsA],
    })
    expect(getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'a-1' }))?.state).toBe(
      'stale',
    )
    // Now native lists it again — row flips back to `alive`.
    const r2 = await janitor({
      nativeList: async () => ({
        sessions: [{ vendorSessionId: 'a-1', title: 't', lastModified: 1 }],
      }),
      workspaces: [wsA],
    })
    expect(r2.refreshed).toBe(1)
    expect(getByC3Id(mintC3SessionId({ vendor: 'claude', vendorSessionId: 'a-1' }))?.state).toBe(
      'alive',
    )
  })

  it('Codex rows are skipped by the janitor (not enumerable)', async () => {
    upsertForBind({
      pendingId: 'p1',
      realId: 'a-1',
      workspacePath: wsA,
      vendor: 'codex',
      agentId: codexAgent,
    })
    nowMs += 10
    touchOnRunEnd({
      realId: 'a-1',
      vendor: 'codex',
      agentId: codexAgent,
      title: 't',
      lastModified: 1,
    })
    nowMs += STALE_MS + 1
    const r = await janitor({
      nativeList: async () => null,
      workspaces: [wsA],
    })
    expect(r.ghosted).toBe(0)
    expect(r.observed).toBe(0)
  })
})

describe('rebuild (F-10)', () => {
  it('rebuildOne populates the projection from a native list', async () => {
    const nativeList: NativeListFn = async () => ({
      sessions: [
        { vendorSessionId: 'a-1', title: 'first', lastModified: 100 },
        { vendorSessionId: 'a-2', title: 'second', lastModified: 200 },
      ],
    })
    const count = await rebuildOne({
      workspacePath: wsA,
      vendor: 'claude',
      agentIdFor: (id) => (id === 'a-1' ? agent1 : id === 'a-2' ? agent2 : null),
      nativeList,
    })
    expect(count).toBe(2)
    const rows = listForWorkspace(wsA)
    expect(rows.map((r) => r.vendorSessionId).sort()).toEqual(['a-1', 'a-2'])
    expect(rows.every((r) => r.state === 'alive')).toBe(true)
  })

  it('rebuildOne no-ops on Codex (not enumerable)', async () => {
    const count = await rebuildOne({
      workspacePath: wsA,
      vendor: 'codex',
      agentIdFor: () => agent1,
      nativeList: async () => null,
    })
    expect(count).toBe(0)
  })
})

describe('fail-soft (no db open)', () => {
  it('all write APIs are no-ops when the db is unavailable', () => {
    resetDbForTests()
    // C3_DB_PATH is unset; getDb() will try the default path. Set a path
    // the driver can't open: an unwritable path.
    const origPath = process.env.C3_DB_PATH
    process.env.C3_DB_PATH = '/nonexistent-readonly/x/y/c3.db'
    try {
      resetDbForTests()
      // These should NOT throw.
      expect(() =>
        upsertPendingRow({
          pendingId: 'pending:abc',
          workspacePath: wsA,
          vendor: 'claude',
          agentId: agent1,
        }),
      ).not.toThrow()
      expect(() =>
        upsertForBind({
          pendingId: 'pending:abc',
          realId: 'r',
          workspacePath: wsA,
          vendor: 'claude',
          agentId: agent1,
        }),
      ).not.toThrow()
      expect(() => updateRealRowTitle('r', 'claude', 't')).not.toThrow()
      expect(() => updateRealRowAgentId('r', 'claude', agent1)).not.toThrow()
      expect(() => deleteByVendorId('claude', 'r')).not.toThrow()
      expect(() => deleteByPendingId('pending:abc')).not.toThrow()
    } finally {
      process.env.C3_DB_PATH = origPath
      resetDbForTests()
    }
  })

  it('all read APIs return empty when the db is unavailable', () => {
    resetDbForTests()
    const origPath = process.env.C3_DB_PATH
    process.env.C3_DB_PATH = '/nonexistent-readonly/x/y/c3.db'
    try {
      resetDbForTests()
      expect(listAll()).toEqual([])
      expect(listForWorkspace(wsA)).toEqual([])
      expect(getByC3Id('c3s_x')).toBeNull()
      expect(getPendingIntent('pending:x')).toBeNull()
    } finally {
      process.env.C3_DB_PATH = origPath
      resetDbForTests()
    }
  })
})

describe('constants (spec invariants)', () => {
  it('STALE_MS and JANITOR_INTERVAL_MS relationship is deterministic for warmup', () => {
    expect(JANITOR_INTERVAL_MS).toBe(STALE_MS / 2)
  })

  it('LAZY_VALIDATE_MS matches STALE_MS (amortization window)', () => {
    expect(LAZY_VALIDATE_MS).toBe(STALE_MS)
  })
})
