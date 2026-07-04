/**
 * `simulateAutomationTrigger` handler (2026-07-04): the diagnostic must reuse the
 * SAME pure evaluator the live dispatch path uses (so a simulation can never report
 * a match the real path would not fire), and it must be side-effect free — no
 * ExecutionLog, no dispatch, no in-flight mutation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Automation } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { createAutomation, listExecutionLogs, resetStoreForTests } from './store.js'
import { simulateAutomationTrigger } from './index.js'
import { evaluateAutomationTriggerMatch } from '../triggers/index.js'
import { inFlight } from './engine.js'

const proj = '/abs/ws-sim'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-sim-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  inFlight.clear()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function fakeCtx() {
  return { broadcastAutomations: vi.fn() } as never
}
function fakeConn() {
  const send = vi.fn()
  return { conn: { send } as never, send }
}

function makeRunSettled(): Automation {
  return createAutomation({
    type: 'command',
    config: { command: 'echo hi' },
    workspaceId: proj,
    triggerType: 'event',
    cronExpression: '',
    eventTopic: 'run:settled',
    eventSessionKindFilter: ['work', 'automation'],
    eventMetadataFilter: { conditions: [{ key: 'stage', value: 'a' }], combinator: 'AND' },
    metadata: {},
    mode: 'sandboxed',
    vendor: 'claude',
  })
}

describe('simulateAutomationTrigger', () => {
  it('returns the same matched verdict as the pure evaluator (match)', () => {
    const automation = makeRunSettled()
    const { conn, send } = fakeConn()
    simulateAutomationTrigger(fakeCtx(), conn, {
      type: 'simulate_automation_trigger',
      automationId: automation.id,
      topic: 'run:settled',
      sessionKind: 'automation',
      reason: 'complete',
      metadata: { stage: 'a' },
    } as never)

    const expected = evaluateAutomationTriggerMatch(automation, 'run:settled', {
      workspacePath: proj,
      sessionKind: 'automation',
      reason: 'complete',
      metadata: { stage: 'a' },
    })
    expect(send).toHaveBeenCalledWith({
      type: 'automation_trigger_simulation_result',
      automationId: automation.id,
      matched: expected.matched,
      breakdown: expected.breakdown,
    })
    expect(expected.matched).toBe(true)
  })

  it('returns the same matched verdict as the pure evaluator (no match)', () => {
    const automation = makeRunSettled()
    const { conn, send } = fakeConn()
    // sessionKind not in filter AND metadata mismatch → not matched.
    simulateAutomationTrigger(fakeCtx(), conn, {
      type: 'simulate_automation_trigger',
      automationId: automation.id,
      topic: 'run:settled',
      sessionKind: 'intent',
      reason: 'complete',
      metadata: { stage: 'b' },
    } as never)

    const payload = send.mock.calls[0]![0] as { matched: boolean }
    expect(payload.matched).toBe(false)
  })

  it('does not create an ExecutionLog, dispatch, or touch in-flight state', () => {
    const automation = makeRunSettled()
    const { conn } = fakeConn()
    simulateAutomationTrigger(fakeCtx(), conn, {
      type: 'simulate_automation_trigger',
      automationId: automation.id,
      topic: 'run:settled',
      sessionKind: 'work',
      reason: 'complete',
      metadata: { stage: 'a' },
    } as never)

    expect(listExecutionLogs(automation.id)).toEqual([])
    expect(inFlight.size).toBe(0)
  })

  it('replies automation.notFound for an unknown id', () => {
    const { conn, send } = fakeConn()
    simulateAutomationTrigger(fakeCtx(), conn, {
      type: 'simulate_automation_trigger',
      automationId: 'nope',
      topic: 'run:settled',
      sessionKind: 'work',
    } as never)
    expect(send).toHaveBeenCalledWith({ type: 'error', error: { code: 'automation.notFound' } })
  })
})
