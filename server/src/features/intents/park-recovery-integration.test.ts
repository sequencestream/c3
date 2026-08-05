/**
 * The park-recovery reply over the REAL store and a real (temp-file) sqlite db.
 *
 * The handler's own unit test mocks the store, so it can only prove the handler
 * reacts correctly to a store that throws. What it cannot prove is the thing that
 * actually matters to a user reading the panel: that an unusable database reaches
 * them AS unusable. That failure lives in the seam between the two — a store that
 * quietly answered "no samples" would satisfy every mocked test while the panel
 * showed a measurement of a machine that was never measured.
 *
 * So this file wires the two together and pins all three outcomes apart: real
 * numbers, a genuinely empty table, and a database that will not open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'

const hoisted = vi.hoisted(() => ({ roots: new Map<string, string>() }))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => hoisted.roots.get(id) ?? null,
}))

import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  MANUAL_UNPARK_REASON,
  appendFunnelEvent,
  resetFunnelStoreForTests,
} from './funnel-store.js'
import { getParkRecoveryStatsHandler } from './park-recovery.js'

let dir: string
const proj = '/abs/integration-project'
const HOUR = 60 * 60 * 1000

function run(workspaceId: string): ServerToClient {
  const sent: ServerToClient[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m) } as never
  getParkRecoveryStatsHandler({} as never, conn, { type: 'get_park_recovery_stats', workspaceId })
  expect(sent).toHaveLength(1)
  return sent[0]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-funnel-e2e-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetFunnelStoreForTests()
  hoisted.roots.clear()
  hoisted.roots.set('ws-1', proj)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDbForTests()
  resetFunnelStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('park recovery over the real store', () => {
  it('reports figures computed from events the store really holds', () => {
    // Matured on purpose: the handler reads at Date.now(), so a park older than
    // the 24h window is what puts a sample in the denominator.
    const now = Date.now()
    appendFunnelEvent({
      workspacePath: proj,
      intentId: 'A',
      stage: 'parked',
      reasonCode: 'max_attempts_reached',
      at: now - 30 * HOUR,
    })
    appendFunnelEvent({
      workspacePath: proj,
      intentId: 'A',
      stage: 'unparked',
      reasonCode: MANUAL_UNPARK_REASON,
      at: now - 29 * HOUR,
    })
    appendFunnelEvent({
      workspacePath: proj,
      intentId: 'B',
      stage: 'parked',
      reasonCode: 'max_attempts_reached',
      at: now - 30 * HOUR,
    })
    appendFunnelEvent({
      workspacePath: proj,
      intentId: 'C',
      stage: 'parked',
      reasonCode: 'max_attempts_reached',
      at: now - HOUR,
    })

    const msg = run('ws-1') as { type: string; stats: Record<string, unknown> }
    expect(msg.type).toBe('park_recovery_stats')
    expect(msg.stats).toEqual({
      windowMs: 24 * HOUR,
      eligible: 2,
      recovered: 1,
      pending: 1,
      rate: 0.5,
    })
  })

  it('reports an empty table as no samples, never 0%', () => {
    const msg = run('ws-1') as { stats: { eligible: number; rate: number | null } }
    expect(msg.stats.eligible).toBe(0)
    expect(msg.stats.rate).toBe(null)
  })

  it('reports an unopenable database as unavailable, not as no samples', () => {
    resetDbForTests()
    resetFunnelStoreForTests()
    // Rooted at a regular file: a missing directory would simply be created.
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    process.env.C3_DB_PATH = join(blocker, 'c3.db')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const msg = run('ws-1') as { type: string; stats?: unknown; error: { code: string } }
    expect(msg.type).toBe('park_recovery_stats')
    expect(msg.stats).toBeUndefined()
    expect(msg.error.code).toBe('intent.parkStatsUnavailable')
  })
})
