/**
 * The server's own attribution of the relay runs it started, kept in memory on
 * purpose. These tests protect the ONE contract the merge credential leans on:
 * a tool call is attributable to the queue's review run only through the live
 * execution handle, never through a session id the call itself supplies.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  bindRelayRunSession,
  lookupRelayRun,
  registerRelayRun,
  resetRelayRunRegistryForTests,
  unregisterRelayRun,
} from './relay-run-registry.js'

beforeEach(() => resetRelayRunRegistryForTests())

const binding = {
  intentId: 'A',
  phase: 'review' as const,
  workspacePath: '/w',
  sessionId: 'pending:review-1',
}

describe('relay run registry', () => {
  it('attributes a call to the run behind its execution handle', () => {
    registerRelayRun('exec-1', binding)
    expect(lookupRelayRun('exec-1')).toEqual(binding)
  })

  it('follows the vendor bind to the real session id, leaving the rest intact', () => {
    registerRelayRun('exec-1', binding)
    bindRelayRunSession('exec-1', 'real-session-1')
    expect(lookupRelayRun('exec-1')).toEqual({
      intentId: 'A',
      phase: 'review',
      workspacePath: '/w',
      sessionId: 'real-session-1',
    })
  })

  it('ignores a bind for an unknown run or an empty session id', () => {
    registerRelayRun('exec-1', binding)
    bindRelayRunSession('exec-none', 'x')
    bindRelayRunSession('exec-1', '')
    expect(lookupRelayRun('exec-1')?.sessionId).toBe('pending:review-1')
  })

  it('forgets a run on unregister, so a finished run no longer vouches for anyone', () => {
    registerRelayRun('exec-1', binding)
    unregisterRelayRun('exec-1')
    expect(lookupRelayRun('exec-1')).toBeNull()
  })

  it('answers null for a handle it never started (manual backfill)', () => {
    expect(lookupRelayRun('exec-unknown')).toBeNull()
  })
})
