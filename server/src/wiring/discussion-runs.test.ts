/**
 * Tests for the discussion lifecycle events published by `startDiscussionRun`.
 *
 * Contracts:
 *  - `startDiscussionRun` is the ONE domain boundary: MCP `start_discussion`, the
 *    Web UI `start_discussion` handler, and `continue_discussion` (new round AND
 *    dangling recovery) each publish exactly one `discussion:start`.
 *  - Its single settle path publishes exactly one `discussion:end` per run,
 *    carrying the terminal reason (`complete` / `error` / `aborted`).
 *  - `startResearchRun` is a preparation stage: it publishes NEITHER — only the
 *    orchestration it auto-starts on success does.
 *  - The end boundary reports the metadata as persisted AT SETTLE TIME, and a
 *    failing re-read or publish never breaks the run cleanup.
 *
 * The orchestrator / research engines and the vendor session plumbing are mocked;
 * the discussion store and the run-control registry are REAL (temp c3.db) so the
 * persisted metadata the events carry is the genuine round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Identity id↔path mapping: synthetic test workspaces are unregistered.
vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))

vi.mock('../features/discussions/orchestrator.js', () => ({
  defaultDiscussionDeps: vi.fn(() => ({})),
  runDiscussion: vi.fn(async () => {}),
}))

vi.mock('../features/discussions/research.js', () => ({
  canAutoStartDiscussion: vi.fn(() => false),
  researchDiscussionContext: vi.fn(async () => ({ ok: true, researchResult: 'R' })),
}))

vi.mock('../features/discussions/agent-session-manager.js', () => ({
  AgentSessionManager: class {},
}))

vi.mock('../features/works/work-session-store.js', () => ({
  deleteByVendorId: vi.fn(),
  touchByOwner: vi.fn(),
  upsertBoundRow: vi.fn(),
}))

import type { Discussion } from '@ccc/shared/protocol'
import type { DiscussionLifecycleEvent } from '@ccc/shared'
import { EventBus, type EventBusEvents } from '../kernel/events/event-bus.js'
import type { VendorAdapter } from '../kernel/agent/adapters/types.js'
import { resetDbForTests } from '../kernel/infra/db.js'
import {
  createDiscussion,
  getDiscussion,
  resetStoreForTests,
  setDiscussionMetadata,
  updateDiscussionStatus,
} from '../features/discussions/store.js'
import { getDiscussionRun } from '../features/discussions/run-controls.js'
import { runContinueDiscussion, runStartDiscussion } from '../features/discussions/tool-defs.js'
import { startDiscussion as startDiscussionHandler } from '../features/discussions/index.js'
import { runDiscussion } from '../features/discussions/orchestrator.js'
import {
  canAutoStartDiscussion,
  researchDiscussionContext,
} from '../features/discussions/research.js'
import { createDiscussionRuns } from './discussion-runs.js'
import type { KernelContext } from '../kernel/types.js'
import type { Conn } from '../transport/handler-registry.js'

const proj = '/abs/disc-runs-proj'
let dir: string
let eventBus: EventBus<EventBusEvents>
let events: Array<{ workspacePath: string } & DiscussionLifecycleEvent>
let runs: ReturnType<typeof createDiscussionRuns>

/** Let the fire-and-forget orchestration promise chain reach its `.finally()`. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function makeRuns(): ReturnType<typeof createDiscussionRuns> {
  return createDiscussionRuns({
    broadcasts: {
      broadcastDiscussions: vi.fn(),
      broadcastDiscussionMessage: vi.fn(),
      broadcastDiscussionDispatchStatus: vi.fn(),
      broadcastDiscussionRunStatus: vi.fn(),
      broadcastResearchMessage: vi.fn(),
      broadcastResearchRunStatus: vi.fn(),
    },
    eventBus,
    getAdapter: () => ({}) as unknown as VendorAdapter,
  })
}

/** Seed a draft discussion with the given persisted metadata. */
function seed(metadata: Record<string, string> = {}): Discussion {
  const d = createDiscussion({ workspacePath: proj, title: 'Cache TTL', type: 'design' })
  if (Object.keys(metadata).length) setDiscussionMetadata(d.id, metadata)
  return getDiscussion(d.id)!
}

const phases = (): string[] => events.map((e) => e.phase)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-disc-runs-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  vi.clearAllMocks()
  vi.mocked(runDiscussion).mockImplementation(async () => {})
  vi.mocked(canAutoStartDiscussion).mockReturnValue(false)
  vi.mocked(researchDiscussionContext).mockResolvedValue({ ok: true, researchResult: 'R' })
  events = []
  eventBus = new EventBus<EventBusEvents>()
  eventBus.subscribe('discussion:lifecycle', (e) => {
    events.push(e)
  })
  runs = makeRuns()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('startDiscussionRun — the shared start boundary', () => {
  it('MCP start_discussion → exactly one discussion:start carrying the persisted metadata', async () => {
    const d = seed()
    const res = runStartDiscussion(
      proj,
      { discussionId: d.id, metadata: { team: 'infra' } },
      { hasDiscussionRun: () => false, startDiscussionRun: runs.startDiscussionRun },
    )
    expect(res.isError).toBeFalsy()
    await flush()
    const start = events.filter((e) => e.phase === 'start')
    expect(start).toHaveLength(1)
    expect(start[0]).toMatchObject({
      workspacePath: proj,
      discussionId: d.id,
      title: 'Cache TTL',
      discussionType: 'design',
      metadata: { team: 'infra' },
    })
    expect(start[0].reason).toBeUndefined()
  })

  it('Web UI start_discussion → exactly one discussion:start (metadata stays {})', async () => {
    const d = seed()
    const ctx = { startDiscussionRun: runs.startDiscussionRun } as unknown as KernelContext
    const conn = { send: vi.fn() } as unknown as Conn
    startDiscussionHandler(ctx, conn, { type: 'start_discussion', discussionId: d.id })
    await flush()
    expect(events.filter((e) => e.phase === 'start')).toHaveLength(1)
    expect(events[0].metadata).toEqual({})
  })

  it('continue_discussion new round → exactly one discussion:start with the ORIGINAL metadata', async () => {
    const d = seed({ team: 'infra' })
    updateDiscussionStatus(d.id, 'completed')
    runContinueDiscussion(
      proj,
      { discussionId: d.id, text: '再来一轮' },
      {
        hasDiscussionRun: () => false,
        startDiscussionRun: runs.startDiscussionRun,
        broadcastDiscussionMessage: vi.fn(),
        broadcastDiscussions: vi.fn(),
      },
    )
    await flush()
    const start = events.filter((e) => e.phase === 'start')
    expect(start).toHaveLength(1)
    expect(start[0].metadata).toEqual({ team: 'infra' })
  })

  it('continue_discussion dangling recovery → exactly one discussion:start', async () => {
    const d = seed({ team: 'infra' })
    updateDiscussionStatus(d.id, 'in_progress')
    runContinueDiscussion(
      proj,
      { discussionId: d.id },
      {
        hasDiscussionRun: () => false,
        startDiscussionRun: runs.startDiscussionRun,
        broadcastDiscussionMessage: vi.fn(),
        broadcastDiscussions: vi.fn(),
      },
    )
    await flush()
    const start = events.filter((e) => e.phase === 'start')
    expect(start).toHaveLength(1)
    expect(start[0].metadata).toEqual({ team: 'infra' })
  })
})

describe('startDiscussionRun — the shared settle boundary', () => {
  it('normal finish → exactly one discussion:end with reason=complete', async () => {
    const d = seed({ team: 'infra' })
    runs.startDiscussionRun(d)
    await flush()
    expect(phases()).toEqual(['start', 'end'])
    expect(events[1]).toMatchObject({
      phase: 'end',
      reason: 'complete',
      discussionId: d.id,
      metadata: { team: 'infra' },
    })
  })

  it('orchestration throw → exactly one discussion:end with reason=error', async () => {
    vi.mocked(runDiscussion).mockRejectedValue(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runs.startDiscussionRun(seed())
    await flush()
    expect(phases()).toEqual(['start', 'end'])
    expect(events[1].reason).toBe('error')
    warn.mockRestore()
  })

  it('abort signal → exactly one discussion:end with reason=aborted (abort wins over error)', async () => {
    vi.mocked(runDiscussion).mockImplementation(async (id: string) => {
      getDiscussionRun(id)!.abort.abort()
      throw new Error('cancelled mid-run')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runs.startDiscussionRun(seed())
    await flush()
    expect(phases()).toEqual(['start', 'end'])
    expect(events[1].reason).toBe('aborted')
    warn.mockRestore()
  })

  it('reports the metadata persisted AT SETTLE TIME, not the start snapshot', async () => {
    const d = seed({ team: 'infra' })
    vi.mocked(runDiscussion).mockImplementation(async (id: string) => {
      setDiscussionMetadata(id, { team: 'core' })
    })
    runs.startDiscussionRun(d)
    await flush()
    expect(events[0].metadata).toEqual({ team: 'infra' })
    expect(events[1].metadata).toEqual({ team: 'core' })
  })

  it('a deleted record at settle time falls back to the start snapshot and still settles', async () => {
    const d = seed({ team: 'infra' })
    vi.mocked(runDiscussion).mockImplementation(async () => {
      // The db is torn down mid-run: the settle re-read cannot succeed.
      resetDbForTests()
      resetStoreForTests()
      process.env.C3_DB_PATH = '/dev/null/nope/c3.db'
    })
    runs.startDiscussionRun(d)
    await flush()
    expect(phases()).toEqual(['start', 'end'])
    expect(events[1].metadata).toEqual({ team: 'infra' })
    // Run cleanup still happened despite the degraded read.
    expect(getDiscussionRun(d.id)).toBeUndefined()
  })

  it('a throwing subscriber never breaks the run cleanup (bus error isolation)', async () => {
    eventBus.subscribe('discussion:lifecycle', () => {
      throw new Error('subscriber exploded')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = seed()
    runs.startDiscussionRun(d)
    await flush()
    expect(phases()).toEqual(['start', 'end'])
    expect(getDiscussionRun(d.id)).toBeUndefined()
    errSpy.mockRestore()
  })
})

describe('startResearchRun — not an orchestration', () => {
  it('research alone publishes NEITHER discussion:start nor discussion:end', async () => {
    runs.startResearchRun(seed({ team: 'infra' }))
    await flush()
    expect(events).toEqual([])
  })

  it('a failed research publishes nothing and does not auto-start', async () => {
    vi.mocked(researchDiscussionContext).mockResolvedValue({ ok: false, researchResult: '' })
    runs.startResearchRun(seed())
    await flush()
    expect(events).toEqual([])
  })

  it('research success that auto-starts the orchestration publishes exactly one pair', async () => {
    vi.mocked(canAutoStartDiscussion).mockReturnValue(true)
    runs.startResearchRun(seed({ team: 'infra' }))
    await flush()
    expect(phases()).toEqual(['start', 'end'])
    expect(events[0].metadata).toEqual({ team: 'infra' })
  })
})
