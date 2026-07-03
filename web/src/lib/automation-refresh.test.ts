import { describe, it, expect } from 'vitest'
import type { AutomationExecutionLog } from '@ccc/shared/protocol'
import {
  AUTOMATION_REFRESH_INTERVAL_MS,
  decideAutomationRefresh,
  isExecutionRunning,
} from './automation-refresh'

function log(over: Partial<AutomationExecutionLog>): AutomationExecutionLog {
  return {
    id: 'e1',
    automationId: 's1',
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    output: '',
    error: null,
    status: null,
    sessionId: 'sess1',
    ...over,
  }
}

describe('isExecutionRunning', () => {
  it('null log is not running', () => {
    expect(isExecutionRunning(null)).toBe(false)
  })
  it('explicit running status', () => {
    expect(isExecutionRunning(log({ status: 'running' }))).toBe(true)
  })
  it('explicit terminal status is not running even without finishedAt', () => {
    expect(isExecutionRunning(log({ status: 'success', finishedAt: null }))).toBe(false)
  })
  it('absent status falls back to finishedAt === null', () => {
    expect(isExecutionRunning(log({ status: null, finishedAt: null }))).toBe(true)
    expect(isExecutionRunning(log({ status: null, finishedAt: 1000 }))).toBe(false)
  })
})

describe('decideAutomationRefresh', () => {
  it('running + active + visible → poll, no final fetch (AC#1)', () => {
    expect(
      decideAutomationRefresh({ running: true, tabActive: true, visible: true, prevRunning: true }),
    ).toEqual({ shouldPoll: true, finalFetch: false })
  })

  it('running → terminal while active → stop polling, fetch once (AC#2)', () => {
    expect(
      decideAutomationRefresh({
        running: false,
        tabActive: true,
        visible: true,
        prevRunning: true,
      }),
    ).toEqual({ shouldPoll: false, finalFetch: true })
  })

  it('non-running (was not running) → no poll, no final fetch (AC#3)', () => {
    expect(
      decideAutomationRefresh({
        running: false,
        tabActive: true,
        visible: true,
        prevRunning: false,
      }),
    ).toEqual({ shouldPoll: false, finalFetch: false })
  })

  it('hidden → skip the poll even while running (AC#4)', () => {
    expect(
      decideAutomationRefresh({
        running: true,
        tabActive: true,
        visible: false,
        prevRunning: true,
      }),
    ).toEqual({ shouldPoll: false, finalFetch: false })
  })

  it('inactive tab → never polls and never final-fetches', () => {
    expect(
      decideAutomationRefresh({
        running: true,
        tabActive: false,
        visible: true,
        prevRunning: true,
      }),
    ).toEqual({ shouldPoll: false, finalFetch: false })
    expect(
      decideAutomationRefresh({
        running: false,
        tabActive: false,
        visible: true,
        prevRunning: true,
      }),
    ).toEqual({ shouldPoll: false, finalFetch: false })
  })

  it('exposes a positive poll interval constant', () => {
    expect(AUTOMATION_REFRESH_INTERVAL_MS).toBeGreaterThan(0)
  })
})
