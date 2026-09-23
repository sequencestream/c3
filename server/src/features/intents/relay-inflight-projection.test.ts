/**
 * The relay in-flight projection — `reviewInFlight` / `fixInFlight` at the
 * `enrichRunStatus` send boundary.
 *
 * These two fields exist so the manual relay button can be hidden exactly while
 * a phase is genuinely occupied, and shown again the moment it is recoverable.
 * The whole risk is that they be a SECOND derivation of "is this phase busy",
 * drifting from the one the queue kernel reads. The cases below pin the
 * projection to the occupancy rule itself (a real `pending:` placeholder with a
 * real projection row, aging across the grace window) rather than to
 * `isRunning` or to a bare `pending` status, and then check the kernel's own
 * `probeRelayRunFacts` agrees verdict for verdict.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { Intent } from '@ccc/shared/protocol'
import type { SessionRuntime } from '../../runs.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { ensureRuntime, getRuntime, isRunning, removeRuntimesForWorkspace } from '../../runs.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { resetStoreForTests } from './store.js'
import {
  resetStoreForTests as resetSessionMetadata,
  upsertPendingRow,
} from '../sessions/session-metadata-store.js'
import { SPEC_OCCUPANCY_GRACE_MS, isSpecOccupancyAlive } from './spec-occupancy.js'
import { probeRelayRunFacts } from './queue-ledger.js'

vi.mock('./action-descriptor.js', () => ({ deriveActionDescriptor: () => null }))
vi.mock('./store.js', async () => {
  const actual = await vi.importActual<typeof import('./store.js')>('./store.js')
  return { ...actual, listIntents: () => [] }
})

const { enrichRunStatus } = await import('./run-status.js')

let dir: string
let proj: string

/**
 * A frozen clock, so a `pending:` placeholder can be aged across the grace
 * window deterministically. Faked for `Date` only: the projection reads
 * `Date.now()` directly while the projection row is stamped by the store, and
 * both must see the same time for "stale" to mean one thing.
 */
const T0 = 1_700_000_000_000

const pending = (tag: string): string => `${PENDING_SESSION_PREFIX}${tag}`

/** Give a session id a live run, the way a launch does. */
function markRunning(sessionId: string): void {
  ensureRuntime(sessionId, proj, 'default', [], 'work')
  getRuntime(sessionId)!.run = {
    abort: new AbortController(),
    handle: null,
  } as SessionRuntime['run']
}

/** Write the projection row a real `pending:` placeholder is always claimed with. */
function claimRow(pendingId: string): void {
  upsertPendingRow({
    pendingId,
    workspacePath: proj,
    vendor: 'claude',
    agentId: 'relay-agent',
    title: 'PR 评审:接力目标',
    ownerKind: 'intent',
    ownerId: 'i-1',
  })
}

function row(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i-1',
    workspaceName: 'ws',
    title: '接力目标',
    status: 'in_progress',
    reviewSessionId: null,
    reviewStatus: null,
    fixSessionId: null,
    fixStatus: null,
    ...over,
  } as unknown as Intent
}

function enrich(over: Partial<Intent> = {}): Intent {
  return enrichRunStatus([row(over)])[0]
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  dir = mkdtempSync(join(tmpdir(), 'c3-relay-inflight-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  proj = resolveWorkspaceRoot(pathToName(dir)!)!
})

afterEach(() => {
  removeRuntimesForWorkspace(proj)
  resetDbForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  vi.useRealTimers()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('enrichRunStatus — relay in-flight derivation', () => {
  it('both fields are false for an intent that never ran a relay phase', () => {
    const r = enrich()
    expect(r.reviewInFlight).toBe(false)
    expect(r.fixInFlight).toBe(false)
  })

  it('a live run occupies its own phase and only its own', () => {
    markRunning('live-review')
    const r = enrich({ reviewSessionId: 'live-review' })
    expect(r.reviewInFlight).toBe(true)
    expect(r.fixInFlight).toBe(false)
  })

  it('a bound session with no live process is NOT in flight', () => {
    // The relay is done with it: the id stays on the ledger as history, and the
    // phase is startable again through whatever rule the ledger now implies.
    const r = enrich({ reviewSessionId: 'bound-but-dead' })
    expect(r.reviewInFlight).toBe(false)
  })

  it('a fresh `pending:` placeholder IS in flight — no live process required', () => {
    // The window between the claim and the vendor's bind has no process at all.
    // Reading this as idle would offer a second launch on a worktree an agent is
    // already about to enter, which is exactly what the placeholder exists to
    // prevent.
    const pendingId = pending('fresh-review')
    claimRow(pendingId)
    expect(enrich({ reviewSessionId: pendingId }).reviewInFlight).toBe(true)
  })

  it('a `pending:` placeholder past the grace window is NOT in flight', () => {
    // The launch died before it bound. Nothing will ever conclude this phase, so
    // it must read as recoverable or the same round could never be re-run.
    const pendingId = pending('dead-review')
    claimRow(pendingId)
    vi.setSystemTime(T0 + SPEC_OCCUPANCY_GRACE_MS + 1)
    expect(enrich({ reviewSessionId: pendingId }).reviewInFlight).toBe(false)
  })

  it('a `pending:` value with no projection row at all is NOT in flight', () => {
    // A broken occupancy (row deleted, or a claim whose projection write failed)
    // must be re-claimable rather than a permanent lock.
    expect(enrich({ reviewSessionId: pending('orphan') }).reviewInFlight).toBe(false)
  })

  it('derives the fix phase from the fix session field, independently', () => {
    const pendingId = pending('fresh-fix')
    claimRow(pendingId)
    const r = enrich({ reviewSessionId: 'bound-dead', fixSessionId: pendingId })
    expect(r.reviewInFlight).toBe(false)
    expect(r.fixInFlight).toBe(true)
  })
})

describe('the projection agrees with the queue kernel', () => {
  it('`*InFlight` is verdict-for-verdict `probeRelayRunFacts`', () => {
    // The kernel decides whether to dispatch a relay phase, and the button
    // decides whether a human may. If those two ever disagreed, a click and a
    // tick could fight over the same round — so the two readers are run over the
    // same rows and must return the same vectors.
    const fresh = pending('agreed-fresh')
    const stale = pending('agreed-stale')
    claimRow(stale)
    vi.setSystemTime(T0 + SPEC_OCCUPANCY_GRACE_MS + 1)
    // Claimed after the window closed, so this one is still inside it.
    claimRow(fresh)
    markRunning('agreed-live')

    // One intent per verdict the rule can produce, so every branch is compared
    // rather than just the one that happens to be interesting.
    const rows = [
      row({ id: 'r-fresh', reviewSessionId: fresh }),
      row({ id: 'r-stale', fixSessionId: stale }),
      row({ id: 'r-live', reviewSessionId: 'agreed-live' }),
      row({ id: 'r-bound', fixSessionId: 'bound-dead' }),
    ]
    const alive = new Map(
      probeRelayRunFacts(rows, { isRunning }, Date.now()).map((f) => [f.sessionId, f.alive]),
    )

    // The rule itself, spelled out: fresh placeholder and live run occupied,
    // stale placeholder and bound-but-dead id not.
    expect([...alive]).toEqual([
      [fresh, true],
      [stale, false],
      ['agreed-live', true],
      ['bound-dead', false],
    ])

    // And the projection the wire carries says exactly the same thing.
    const enriched = enrichRunStatus(rows)
    expect(
      enriched.map((r) => [
        r.reviewSessionId ? alive.get(r.reviewSessionId) : false,
        r.fixSessionId ? alive.get(r.fixSessionId) : false,
      ]),
    ).toEqual(enriched.map((r) => [r.reviewInFlight, r.fixInFlight]))
  })
})
