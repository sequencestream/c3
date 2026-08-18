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
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))

vi.mock('../features/discussions/orchestrator.js', () => ({
  defaultDiscussionDeps: vi.fn(() => ({})),
  runDiscussion: vi.fn(async () => {}),
}))

vi.mock('../features/discussions/research.js', () => ({
  canAutoStartDiscussion: vi.fn(() => false),
  researchDiscussionContext: vi.fn(async () => ({ ok: true, researchResult: 'R' })),
  resolveResearchAgent: vi.fn(() => ({ id: 'system', vendor: 'claude' })),
}))

// The session→agent fact store writes to the real settings file; the binding itself
// is asserted through this spy rather than by reading config from disk.
vi.mock('../kernel/agent-config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../kernel/agent-config/index.js')>()),
  freezeSessionAgent: vi.fn(),
}))

vi.mock('../features/discussions/agent-session-manager.js', () => ({
  AgentSessionManager: class {},
}))

vi.mock('../features/works/work-session-store.js', () => ({
  deleteByVendorId: vi.fn(),
  touchByOwner: vi.fn(),
  upsertBoundRow: vi.fn(),
}))

import type { AgentConfig, Discussion, ServerToClient } from '@ccc/shared/protocol'
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
  resolveResearchAgent,
} from '../features/discussions/research.js'
import { createDiscussionRuns, settleResearchSessionRun } from './discussion-runs.js'
import { ensureRuntime, getRuntime, removeRuntime } from '../runs.js'
import { freezeSessionAgent, systemAgent } from '../kernel/agent-config/index.js'
import { upsertBoundRow } from '../features/works/work-session-store.js'
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
  vi.mocked(resolveResearchAgent).mockReturnValue(systemAgent())
  events = []
  eventBus = new EventBus<EventBusEvents>()
  eventBus.subscribe('discussion:lifecycle', (e) => {
    events.push(e)
  })
  runs = makeRuns()
})

afterEach(() => {
  // The runtime registry is module-global; drop the sessions this file registered so
  // one test's buffer can never leak into the next.
  for (const id of ['vsess-1', 'vsess-stop', 'vsess-fu', 'vsess-mute']) removeRuntime(id)
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

  it('Web UI start_discussion restarts a dangling in_progress discussion (no live run)', async () => {
    const d = seed()
    updateDiscussionStatus(d.id, 'in_progress')
    const ctx = { startDiscussionRun: runs.startDiscussionRun } as unknown as KernelContext
    const conn = { send: vi.fn() } as unknown as Conn
    startDiscussionHandler(ctx, conn, { type: 'start_discussion', discussionId: d.id })
    await flush()
    expect(conn.send).not.toHaveBeenCalled()
    expect(events.filter((e) => e.phase === 'start')).toHaveLength(1)
    expect(vi.mocked(runDiscussion)).toHaveBeenCalledTimes(1)
  })

  it('Web UI start_discussion rejects a concluded discussion and starts nothing', async () => {
    const d = seed()
    updateDiscussionStatus(d.id, 'completed')
    const ctx = { startDiscussionRun: runs.startDiscussionRun } as unknown as KernelContext
    const conn = { send: vi.fn() } as unknown as Conn
    startDiscussionHandler(ctx, conn, { type: 'start_discussion', discussionId: d.id })
    await flush()
    expect(conn.send).toHaveBeenCalledWith({
      type: 'error',
      error: { code: 'discussion.alreadyStarted' },
    })
    expect(events).toEqual([])
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

describe('startResearchRun — the research run is a first-class session', () => {
  /** Drive the mocked research routine: report a session id, stream, then resolve. */
  function research(
    sessionId: string | null,
    wire: ServerToClient[] = [],
    result = { ok: true, researchResult: 'R' },
  ): void {
    vi.mocked(researchDiscussionContext).mockImplementation(async (_d, _agent, opts = {}) => {
      if (sessionId) opts.onSessionId?.(sessionId)
      for (const ev of wire) opts.onWire?.(ev)
      return result
    })
  }

  it('persists the captured session id, registers a running runtime and projects a session row', async () => {
    research('vsess-1', [{ type: 'assistant_text', text: 'partial' }])
    const d = seed()
    let liveStatus: string | undefined
    vi.mocked(researchDiscussionContext).mockImplementation(async (_d, _agent, opts = {}) => {
      opts.onSessionId?.('vsess-1')
      opts.onWire?.({ type: 'assistant_text', text: 'partial' })
      // Observed from INSIDE the run — the session must read as running while alive.
      liveStatus = getRuntime('vsess-1')?.status
      return { ok: true, researchResult: 'FINDINGS' }
    })

    runs.startResearchRun(d)
    await flush()

    expect(getDiscussion(d.id)?.researchSessionId).toBe('vsess-1')
    expect(liveStatus).toBe('running')
    // The research marker is what makes the read-only profile apply to follow-ups.
    expect(getRuntime('vsess-1')?.researchDiscussionId).toBe(d.id)
    expect(getRuntime('vsess-1')?.sessionKind).toBe('discussion')
    // Wire events land in the runtime buffer, so a viewer sees the unattended run.
    expect(getRuntime('vsess-1')?.buffer).toContainEqual({
      type: 'assistant_text',
      text: 'partial',
    })
    // Bound to the claude research agent so a follow-up can actually resume it.
    expect(vi.mocked(freezeSessionAgent)).toHaveBeenCalledWith(
      'vsess-1',
      'vsess-1',
      'system',
      proj,
      'host',
    )
    // Listed on the sessions page under the existing discussion category.
    expect(vi.mocked(upsertBoundRow)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'vsess-1',
        sessionKind: 'discussion',
        ownerKind: 'discussion',
        ownerId: d.id,
      }),
    )
    // The turn is over: no in-flight run left on the runtime.
    expect(getRuntime('vsess-1')?.run).toBeNull()
  })

  it('executor, frozen agent and bound row all come from the ONE up-front resolution', async () => {
    // The resolver is consulted exactly once, up front. Even if its answer would
    // change before the vendor reports the session id, the three session facts
    // stay pinned to the launch-time agent — no independent second resolution.
    const launchAgent: AgentConfig = { ...systemAgent(), id: 'claude-org' }
    const laterAgent: AgentConfig = { ...systemAgent(), id: 'claude-other' }
    vi.mocked(resolveResearchAgent).mockReturnValueOnce(launchAgent).mockReturnValueOnce(laterAgent)
    let passedAgent: AgentConfig | undefined
    vi.mocked(researchDiscussionContext).mockImplementation(async (_d, agent, opts = {}) => {
      passedAgent = agent
      opts.onSessionId?.('vsess-1')
      return { ok: true, researchResult: 'R' }
    })

    runs.startResearchRun(seed())
    await flush()

    // The first turn runs on the launch-time agent…
    expect(passedAgent?.id).toBe('claude-org')
    // …the freeze pins that SAME agent (so a follow-up resumes on it)…
    expect(vi.mocked(freezeSessionAgent)).toHaveBeenCalledWith(
      'vsess-1',
      'vsess-1',
      'claude-org',
      proj,
      'host',
    )
    // …and the bound row projects the same execution identity.
    expect(vi.mocked(upsertBoundRow)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'vsess-1',
        vendor: 'claude',
        agentId: 'claude-org',
      }),
    )
    // And the resolver was never consulted again during the run.
    expect(vi.mocked(resolveResearchAgent)).toHaveBeenCalledTimes(1)
  })

  it('Stop on the research session aborts the run through the runtime', async () => {
    let aborted = false
    vi.mocked(researchDiscussionContext).mockImplementation(async (_d, _agent, opts = {}) => {
      opts.onSessionId?.('vsess-stop')
      // The status bar's Stop aborts `rt.run.abort` — the research run must see it.
      getRuntime('vsess-stop')!.run!.abort.abort()
      aborted = opts.signal?.aborted ?? false
      return { ok: false, researchResult: '' }
    })
    runs.startResearchRun(seed())
    await flush()
    expect(aborted).toBe(true)
  })

  it('a run that dies before the vendor reports an id leaves the discussion without a session', async () => {
    research(null, [], { ok: false, researchResult: '' })
    const d = seed()
    runs.startResearchRun(d)
    await flush()
    expect(getDiscussion(d.id)?.researchSessionId).toBeUndefined()
    expect(vi.mocked(upsertBoundRow)).not.toHaveBeenCalled()
  })
})

describe('settleResearchTurn — one write-back rule for both lifecycles', () => {
  it('a non-empty result replaces researchResult', () => {
    const d = seed()
    runs.settleResearchTurn(d.id, '  NEW FINDINGS  ', true)
    expect(getDiscussion(d.id)?.researchResult).toBe('NEW FINDINGS')
  })

  it('an empty or blank result leaves the previous findings untouched', () => {
    const d = seed()
    runs.settleResearchTurn(d.id, 'FIRST PASS', true)
    runs.settleResearchTurn(d.id, '   \n ', true)
    expect(getDiscussion(d.id)?.researchResult).toBe('FIRST PASS')
  })

  it('a failed turn keeps the previous findings AND never auto-starts', () => {
    vi.mocked(canAutoStartDiscussion).mockReturnValue(true)
    const d = seed()
    runs.settleResearchTurn(d.id, 'FIRST PASS', true)
    events.length = 0
    runs.settleResearchTurn(d.id, '', false)
    expect(getDiscussion(d.id)?.researchResult).toBe('FIRST PASS')
    expect(events).toEqual([])
  })

  it('an aborted turn discards its partial output — no write-back, no auto-start', async () => {
    const d = seed()
    runs.settleResearchTurn(d.id, 'FIRST PASS', true)
    // Auto-start would otherwise be refused for an unrelated reason — arm it so the
    // assertion below can only be explained by the abort.
    vi.mocked(canAutoStartDiscussion).mockReturnValue(true)
    // What a shutdown/stop leaves behind: the researcher had emitted an opening
    // sentence when its child died. That is a half-finished draft, not the findings.
    runs.settleResearchTurn(d.id, "I'll research the project's current state", false)
    await flush()
    expect(getDiscussion(d.id)?.researchResult).toBe('FIRST PASS')
    expect(events).toEqual([])
  })

  it('a successful turn on a still-draft discussion auto-starts the orchestration', async () => {
    vi.mocked(canAutoStartDiscussion).mockReturnValue(true)
    const d = seed()
    runs.settleResearchTurn(d.id, 'FINDINGS', true)
    await flush()
    expect(phases()).toEqual(['start', 'end'])
  })

  it('the first research pass writes back through the same rule', async () => {
    vi.mocked(researchDiscussionContext).mockResolvedValue({
      ok: true,
      researchResult: 'FIRST PASS',
    })
    const d = seed()
    runs.startResearchRun(d)
    await flush()
    expect(getDiscussion(d.id)?.researchResult).toBe('FIRST PASS')
  })
})

describe('settleResearchSessionRun — the follow-up half', () => {
  it('takes the LAST assistant text of the last turn off the runtime and writes it back', () => {
    const d = seed()
    const rt = ensureRuntime('vsess-fu', proj, 'default', [], 'discussion', undefined, 'internal')
    rt.buffer.push(
      { type: 'user_text', text: 'first research prompt' },
      { type: 'assistant_text', text: 'OLD FINDINGS' },
      { type: 'user_text', text: 'please re-check the cache layer' },
      { type: 'assistant_text', text: 'interim note' },
      { type: 'assistant_text', text: 'CORRECTED FINDINGS' },
    )
    settleResearchSessionRun(runs, d.id, 'vsess-fu', 'complete')
    expect(getDiscussion(d.id)?.researchResult).toBe('CORRECTED FINDINGS')
  })

  it('a turn that produced no assistant text leaves the previous findings alone', () => {
    const d = seed()
    runs.settleResearchTurn(d.id, 'FIRST PASS', true)
    const rt = ensureRuntime('vsess-mute', proj, 'default', [], 'discussion', undefined, 'internal')
    rt.buffer.push({ type: 'user_text', text: 'a question' })
    settleResearchSessionRun(runs, d.id, 'vsess-mute', 'complete')
    expect(getDiscussion(d.id)?.researchResult).toBe('FIRST PASS')
  })
})
