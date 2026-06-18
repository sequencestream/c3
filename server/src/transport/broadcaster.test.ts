/**
 * Broadcaster characterization tests (server refactor 2/3b).
 *
 * The byte-level guarantee for the broadcast consolidation: collapsing the ~12
 * inline `for (const deliver of connections) deliver(frame)` loops into a single
 * `broadcaster.toAll(frame)` MUST change nothing on the wire. These tests pin
 * that the Broadcaster is a TRANSPARENT fan-out — every live connection receives
 * bytes exactly equal to `JSON.stringify(frame)`, with no mutation, reordering,
 * or field drift — plus golden snapshots of the high-frequency frame shapes.
 *
 * This replaces the runtime "shadow double-run" with a permanent, deterministic
 * CI guard (the frame CONSTRUCTION stays verbatim in the server closures; only
 * DELIVERY moved, which is exactly what these tests characterize). The runtime
 * `C3_BROADCAST_SHADOW` tracer remains for the manual two-tab fan-out smoke.
 */
import { describe, expect, it } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import { createBroadcaster, type Deliver } from './broadcaster.js'

/** Build a broadcaster with `n` capturing connections; returns the capture logs. */
function withConnections(n: number): {
  broadcaster: ReturnType<typeof createBroadcaster>
  logs: ServerToClient[][]
  delivers: Deliver[]
} {
  const connections = new Set<Deliver>()
  const broadcaster = createBroadcaster(connections)
  const logs: ServerToClient[][] = []
  const delivers: Deliver[] = []
  for (let i = 0; i < n; i++) {
    const log: ServerToClient[] = []
    const deliver: Deliver = (m) => log.push(m)
    logs.push(log)
    delivers.push(deliver)
    broadcaster.add(deliver)
  }
  return { broadcaster, logs, delivers }
}

// One representative frame per broadcast type — the exhaustive list the server
// closures emit through `toAll`. Typed `ServerToClient`, so a shape change in the
// protocol breaks compilation here (the per-type wire contract is pinned).
const REPRESENTATIVE_FRAMES: ServerToClient[] = [
  { type: 'session_status', statuses: [{ sessionId: 's1', status: 'running' }] },
  { type: 'intents', workspaceId: '/p', items: [], sddEnabled: false },
  { type: 'discussions', workspaceId: '/p', items: [], runStates: {}, researchStates: {} },
  { type: 'schedules', workspaceId: '/p', items: [] },
  {
    type: 'discussion_message',
    discussionId: 'd1',
    message: {
      id: 'm1',
      discussionId: 'd1',
      seq: 1,
      speakerKind: 'human',
      speakerAgentId: null,
      speakerName: 'Human',
      content: 'hi',
      createdAt: 0,
    },
  },
  {
    type: 'discussion_dispatch_status',
    discussionId: 'd1',
    phase: 'pending',
    agents: [
      { id: 'a1', name: 'Agent One' },
      { id: 'a2', name: 'Agent Two' },
    ],
  },
  {
    type: 'discussion_dispatch_status',
    discussionId: 'd1',
    phase: 'failed',
    agents: [{ id: 'a1', name: 'Agent One' }],
    error: 'boom',
  },
  { type: 'discussion_run_status', discussionId: 'd1', state: 'running' },
  {
    type: 'research_message',
    discussionId: 'd1',
    message: { discussionId: 'd1', seq: 1, kind: 'text', content: 'r', createdAt: 0 },
  },
  { type: 'research_run_status', discussionId: 'd1', state: 'ended' },
  {
    type: 'automation_status',
    status: {
      workspaceId: '/p',
      state: 'idle',
      currentIntentId: null,
      currentSessionId: null,
      awaitingPermission: false,
      error: null,
      completedIds: [],
      startedAt: null,
    },
  },
]

describe('Broadcaster — transparent fan-out (2/3b byte guarantee)', () => {
  it('delivers bytes exactly equal to JSON.stringify(frame) to every connection', () => {
    const { broadcaster, logs } = withConnections(3)
    for (const frame of REPRESENTATIVE_FRAMES) {
      broadcaster.toAll(frame)
    }
    const expected = REPRESENTATIVE_FRAMES.map((f) => JSON.stringify(f))
    for (const log of logs) {
      // Every connection received every frame, in order, byte-identical.
      expect(log.map((f) => JSON.stringify(f))).toEqual(expected)
    }
  })

  it('fans the SAME frame to all connections (no per-connection divergence)', () => {
    const { broadcaster, logs } = withConnections(4)
    const frame: ServerToClient = { type: 'session_status', statuses: [] }
    broadcaster.toAll(frame)
    const bytesPerConn = logs.map((log) => JSON.stringify(log[0]))
    expect(new Set(bytesPerConn).size).toBe(1)
  })

  it('does not mutate or reorder the frame it forwards', () => {
    const { broadcaster, logs } = withConnections(1)
    const frame: ServerToClient = {
      type: 'discussions',
      workspaceId: '/p',
      items: [],
      runStates: { d1: 'running' },
      researchStates: { d1: 'running' },
    }
    const before = JSON.stringify(frame)
    broadcaster.toAll(frame)
    expect(JSON.stringify(frame)).toBe(before) // source untouched
    expect(JSON.stringify(logs[0][0])).toBe(before) // delivered untouched
  })
})

describe('Broadcaster — connection set membership', () => {
  it('add includes a connection; remove excludes it; size tracks count', () => {
    const connections = new Set<Deliver>()
    const broadcaster = createBroadcaster(connections)
    const a: ServerToClient[] = []
    const b: ServerToClient[] = []
    const da: Deliver = (m) => a.push(m)
    const db: Deliver = (m) => b.push(m)

    broadcaster.add(da)
    broadcaster.add(db)
    expect(broadcaster.size()).toBe(2)

    broadcaster.remove(db)
    expect(broadcaster.size()).toBe(1)

    broadcaster.toAll({ type: 'session_status', statuses: [] })
    expect(a).toHaveLength(1) // still live
    expect(b).toHaveLength(0) // removed before the send
  })

  it('a frame sent with zero connections is a silent no-op', () => {
    const { broadcaster } = withConnections(0)
    expect(() => broadcaster.toAll({ type: 'session_status', statuses: [] })).not.toThrow()
  })
})

describe('Broadcaster — golden wire shapes (high-frequency frames)', () => {
  it('session_status', () => {
    expect(JSON.stringify({ type: 'session_status', statuses: [] } satisfies ServerToClient)).toBe(
      '{"type":"session_status","statuses":[]}',
    )
  })

  it('intents', () => {
    expect(
      JSON.stringify({
        type: 'intents',
        workspaceId: '/p',
        items: [],
        sddEnabled: false,
      } satisfies ServerToClient),
    ).toBe('{"type":"intents","workspaceId":"/p","items":[],"sddEnabled":false}')
  })

  it('discussions (carries runStates + researchStates snapshots)', () => {
    expect(
      JSON.stringify({
        type: 'discussions',
        workspaceId: '/p',
        items: [],
        runStates: {},
        researchStates: {},
      } satisfies ServerToClient),
    ).toBe(
      '{"type":"discussions","workspaceId":"/p","items":[],"runStates":{},"researchStates":{}}',
    )
  })
})
