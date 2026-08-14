/**
 * The read-only park-recovery reply.
 *
 * Three things it must get right: it answers only for a workspace the server can
 * resolve, it carries counts and nothing identifying, and a failed read is
 * reported AS a failure — the one thing that must never happen is a query error
 * arriving at the panel dressed up as 0% or "no samples".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

const hoisted = vi.hoisted(() => ({
  roots: new Map<string, string>(),
  figures: {
    windowMs: 24 * 60 * 60 * 1000,
    eligible: 4,
    recovered: 3,
    pending: 2,
    rate: 0.75,
  },
  throws: false,
}))

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => hoisted.roots.get(id) ?? null,
}))

vi.mock('./funnel-store.js', () => ({
  parkRecoveryFigures: () => {
    if (hoisted.throws) throw new Error('db exploded')
    return hoisted.figures
  },
}))

import { getParkRecoveryStatsHandler } from './park-recovery.js'

function run(workspaceName: string): ServerToClient {
  const sent: ServerToClient[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m) } as never
  getParkRecoveryStatsHandler({} as never, conn, {
    type: 'get_park_recovery_stats',
    workspaceName,
  })
  expect(sent).toHaveLength(1)
  return sent[0]
}

beforeEach(() => {
  hoisted.roots.clear()
  hoisted.roots.set('ws-1', '/abs/proj-1')
  hoisted.throws = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getParkRecoveryStatsHandler', () => {
  it('replies with the counts for a resolvable workspace', () => {
    const msg = run('ws-1')
    expect(msg).toEqual({
      type: 'park_recovery_stats',
      workspaceName: 'ws-1',
      stats: { windowMs: 86_400_000, eligible: 4, recovered: 3, pending: 2, rate: 0.75 },
    })
  })

  it('exposes no intent, reason or free text', () => {
    const msg = run('ws-1') as unknown as { stats: Record<string, unknown> }
    expect(Object.keys(msg.stats).sort()).toEqual([
      'eligible',
      'pending',
      'rate',
      'recovered',
      'windowMs',
    ])
  })

  it('rejects a workspace this connection cannot resolve', () => {
    const msg = run('ws-unknown') as { type: string; error: { code: string } }
    expect(msg.type).toBe('error')
    expect(msg.error.code).toBe('workspace.unknown')
  })

  it('reports a failed read as unavailable instead of an empty measurement', () => {
    hoisted.throws = true
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const msg = run('ws-1') as { type: string; stats?: unknown; error: { code: string } }
    expect(msg.type).toBe('park_recovery_stats')
    expect(msg.stats).toBeUndefined()
    expect(msg.error.code).toBe('intent.parkStatsUnavailable')
  })
})
