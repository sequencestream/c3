import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import {
  activityRegistry,
  badgeProjection,
  resetActivityRegistryForTests,
} from '../kernel/activity/index.js'
import type { Conn } from '../transport/handler-registry.js'
import { createActivityPush, registerActivityPush } from './activity-push.js'

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  return {
    sent,
    conn: {
      send: (m: ServerToClient) => sent.push(m),
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      subject: null,
      authed: true,
      authToken: null,
    } as Conn,
  }
}

let unsub: (() => void) | undefined

beforeEach(() => {
  resetActivityRegistryForTests()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  unsub?.()
  unsub = undefined
  resetActivityRegistryForTests()
  vi.restoreAllMocks()
})

describe('createActivityPush', () => {
  it('sends a snapshot of only the visible workspaces', () => {
    activityRegistry.start({
      activityId: 's-a',
      sessionId: 's-a',
      workspaceName: 'alpha',
      sessionKind: 'work',
    })
    activityRegistry.start({
      activityId: 's-b',
      sessionId: 's-b',
      workspaceName: 'secret',
      sessionKind: 'work',
    })
    const push = createActivityPush(() => ['alpha'])
    const { conn, sent } = fakeConn()
    push.sendSnapshot(conn)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe('activity_snapshot')
    if (sent[0]?.type !== 'activity_snapshot') throw new Error('expected snapshot')
    expect(Object.keys(sent[0].workspaces)).toEqual(['alpha'])
    expect(sent[0].workspaces.alpha?.runningSessions).toBe(1)
    expect(sent[0].revision).toBe(badgeProjection.getRevision())
  })

  it('broadcasts a filtered delta after the snapshot', () => {
    const push = createActivityPush((conn) =>
      conn.subject === 'alice' ? ['alpha'] : ['alpha', 'beta'],
    )
    unsub = registerActivityPush(push)
    const alice = fakeConn()
    alice.conn.subject = 'alice'
    const admin = fakeConn()
    admin.conn.subject = 'root'
    push.sendSnapshot(alice.conn)
    push.add(alice.conn)
    push.sendSnapshot(admin.conn)
    push.add(admin.conn)
    alice.sent.length = 0
    admin.sent.length = 0

    activityRegistry.start({
      activityId: 's-b',
      sessionId: 's-b',
      workspaceName: 'beta',
      sessionKind: 'work',
    })

    expect(alice.sent).toHaveLength(1)
    expect(admin.sent).toHaveLength(1)
    expect(alice.sent[0]?.type).toBe('activity_delta')
    expect(admin.sent[0]?.type).toBe('activity_delta')
    if (alice.sent[0]?.type !== 'activity_delta' || admin.sent[0]?.type !== 'activity_delta') {
      throw new Error('expected delta')
    }
    expect(alice.sent[0].changedWorkspaces).not.toHaveProperty('beta')
    expect(admin.sent[0].changedWorkspaces.beta?.runningSessions).toBe(1)
    expect(alice.sent[0].revision).toBe(admin.sent[0].revision)
  })

  it('does not deliver after remove', () => {
    const push = createActivityPush(() => ['alpha'])
    unsub = registerActivityPush(push)
    const { conn, sent } = fakeConn()
    push.sendSnapshot(conn)
    push.add(conn)
    push.remove(conn)
    sent.length = 0
    activityRegistry.start({
      activityId: 's-a',
      sessionId: 's-a',
      workspaceName: 'alpha',
      sessionKind: 'work',
    })
    expect(sent).toEqual([])
  })
})
