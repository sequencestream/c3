/**
 * Execution-chain coverage for the automation list's live-session indicator
 * (`Automation.runningSessionId`).
 *
 * The list is refreshed by three pushes around one LLM execution: the
 * `run:started` event, the extra broadcast the engine fires when the real agent
 * session id is persisted, and the `run:settled` event. What matters is the
 * SNAPSHOT each push would carry, so this test reads the real store at exactly
 * those three moments and asserts the indicator goes dark → lit → dark. The
 * subscriptions that turn the two events into a list broadcast are covered in
 * `wiring/run-domain-subscriptions.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Identity workspace resolution: fixtures use the path itself as the id.
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))

vi.mock('../../kernel/config/index.js', () => ({
  getTimezone: () => 'UTC',
  getAutomationEnabled: () => true,
}))

// The dispatcher is replaced by a scripted run: bind a session id, then settle.
const dispatch = vi.hoisted(() => ({
  run: null as
    null | ((logId: string, updateLog: (id: string, p: Record<string, unknown>) => void) => void),
}))
vi.mock('./dispatcher.js', () => ({
  execute: vi.fn(
    async (
      _automation: unknown,
      logId: string,
      updateLog: (id: string, p: Record<string, unknown>) => void,
    ) => {
      dispatch.run?.(logId, updateLog)
    },
  ),
}))

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { EventBus, type EventBusEvents } from '../../kernel/events/event-bus.js'
import { dispatchAndTrack, setEventBus, setExecutionStore } from './engine.js'
import {
  appendExecutionLog,
  createAutomation,
  deleteAutomation,
  getAutomation,
  getDueAutomations,
  getEventAutomations,
  listAutomations,
  resetStoreForTests,
  updateAutomation,
  updateExecutionLog,
  updateNextRunAt,
} from './store.js'

const proj = '/abs/workspace-a'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-run-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  dispatch.run = null
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('automation list live-session indicator — one execution end to end', () => {
  it('is dark at run:started, lit once the real session id lands, dark again at run:settled', async () => {
    const automation = createAutomation({
      type: 'llm',
      config: { prompt: 'review the diff' },
      workspaceId: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
      agentId: 'agent-1',
    })

    // Every push records the indicator value the refreshed list would carry.
    const snapshots: { at: string; runningSessionId: string | null }[] = []
    const snap = (at: string): void => {
      const row = listAutomations(proj).find((a) => a.id === automation.id)!
      snapshots.push({ at, runningSessionId: row.runningSessionId })
    }

    const eventBus = new EventBus<EventBusEvents>()
    eventBus.subscribe('run:started', ({ sessionKind }) => {
      if (sessionKind === 'automation') snap('run:started')
    })
    eventBus.subscribe('run:settled', ({ sessionKind }) => {
      if (sessionKind === 'automation') snap('run:settled')
    })
    setEventBus(eventBus)

    setExecutionStore({
      getDueAutomations,
      getEventAutomations,
      getAutomation,
      updateNextRunAt,
      updateAutomation: (id, patch) =>
        updateAutomation(id, { status: patch.status as 'active' | 'paused' | undefined }),
      deleteAutomation,
      appendExecutionLog: (input) => appendExecutionLog({ ...input, status: 'running' }),
      updateExecutionLog,
      broadcast: () => snap('session-bound'),
    })

    // The run binds its real agent session id first, then finishes.
    dispatch.run = (logId, updateLog) => {
      updateLog(logId, { sessionId: 'sess-live' })
      updateLog(logId, { status: 'success', finishedAt: Date.now(), output: 'ok' })
    }

    dispatchAndTrack(automation)
    await vi.waitFor(() => expect(snapshots.map((s) => s.at)).toContain('run:settled'))

    expect(snapshots).toEqual([
      // Started: the log exists but has no real session id yet.
      { at: 'run:started', runningSessionId: null },
      // Bound: this extra broadcast is what actually lights the indicator up.
      { at: 'session-bound', runningSessionId: 'sess-live' },
      // Settled: the log reached its terminal status BEFORE the event fired.
      { at: 'run:settled', runningSessionId: null },
    ])
  })

  it('does not re-broadcast on later log updates once the session id is bound', async () => {
    const automation = createAutomation({
      type: 'llm',
      config: { prompt: 'review the diff' },
      workspaceId: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
      agentId: 'agent-1',
    })
    const broadcast = vi.fn()
    const eventBus = new EventBus<EventBusEvents>()
    const settled = vi.fn()
    eventBus.subscribe('run:settled', settled)
    setEventBus(eventBus)
    setExecutionStore({
      getDueAutomations,
      getEventAutomations,
      getAutomation,
      updateNextRunAt,
      updateAutomation: (id, patch) =>
        updateAutomation(id, { status: patch.status as 'active' | 'paused' | undefined }),
      deleteAutomation,
      appendExecutionLog: (input) => appendExecutionLog({ ...input, status: 'running' }),
      updateExecutionLog,
      broadcast,
    })

    dispatch.run = (logId, updateLog) => {
      updateLog(logId, { sessionId: 'sess-live' })
      updateLog(logId, { sessionId: 'sess-live' })
      updateLog(logId, { output: 'partial' })
      updateLog(logId, { status: 'success', finishedAt: Date.now() })
    }

    dispatchAndTrack(automation)
    await vi.waitFor(() => expect(settled).toHaveBeenCalled())
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith(proj)
  })
})
