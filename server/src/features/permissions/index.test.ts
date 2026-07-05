/**
 * `permission_response` handler — carries the responding connection's authenticated
 * subject into the permission decision (so the `save_intents` gate can attribute
 * `intent_logs.actor`), while the wait-user-involve `done`/`canceled` transition and
 * broadcast are unchanged. The subject is server-authoritative (`conn.subject`), never
 * read from the client message body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../runs.js', () => ({ resolvePending: vi.fn() }))
vi.mock('../../state.js', () => ({ resolveWorkspaceRoot: vi.fn(() => '/abs/proj') }))
vi.mock('../user-involve/store.js', () => ({
  getEventByRequestId: vi.fn(() => null),
  updateStatus: vi.fn(),
}))

import { permissionResponse } from './index.js'
import { waitForDecision, pendingCount } from '../../kernel/permission/index.js'
import { getEventByRequestId, updateStatus } from '../user-involve/store.js'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'

function fakeConn(subject: string | null): Conn {
  return { subject } as unknown as Conn
}

function fakeCtx(): { ctx: KernelContext; broadcast: ReturnType<typeof vi.fn> } {
  const broadcast = vi.fn()
  return { ctx: { broadcastWaitUserEvents: broadcast } as unknown as KernelContext, broadcast }
}

afterEach(() => {
  vi.mocked(getEventByRequestId).mockReset().mockReturnValue(null)
  vi.mocked(updateStatus).mockReset()
})

describe('permissionResponse', () => {
  it('carries conn.subject into the resolved decision as actor', async () => {
    const p = waitForDecision('req-alice')
    expect(pendingCount()).toBe(1)

    const { ctx } = fakeCtx()
    permissionResponse(ctx, fakeConn('alice'), {
      type: 'permission_response',
      requestId: 'req-alice',
      decision: 'allow',
    })

    await expect(p).resolves.toMatchObject({ decision: 'allow', actor: 'alice' })
  })

  it('passes a null subject through as a null actor (unauthenticated / auth disabled)', async () => {
    const p = waitForDecision('req-null')
    const { ctx } = fakeCtx()
    permissionResponse(ctx, fakeConn(null), {
      type: 'permission_response',
      requestId: 'req-null',
      decision: 'allow',
    })

    await expect(p).resolves.toMatchObject({ decision: 'allow', actor: null })
  })

  it('never derives the actor from the client message body', async () => {
    const p = waitForDecision('req-forge')
    const { ctx } = fakeCtx()
    // A forged `actor` in the wire message must be ignored — only conn.subject counts.
    permissionResponse(ctx, fakeConn('carol'), {
      type: 'permission_response',
      requestId: 'req-forge',
      decision: 'allow',
      actor: 'attacker',
    } as never)

    await expect(p).resolves.toMatchObject({ decision: 'allow', actor: 'carol' })
  })

  it('resolves the matching wait-user event to done and broadcasts (order unchanged)', () => {
    vi.mocked(getEventByRequestId).mockReturnValue({
      id: 'evt-1',
      workspaceId: 'ws-1',
    } as never)
    const { ctx, broadcast } = fakeCtx()
    permissionResponse(ctx, fakeConn('alice'), {
      type: 'permission_response',
      requestId: 'req-evt',
      decision: 'allow',
    })
    expect(updateStatus).toHaveBeenCalledWith('evt-1', 'done')
    expect(broadcast).toHaveBeenCalledWith('/abs/proj')
  })

  it('a deny with no matching event updates nothing and does not broadcast', () => {
    const { ctx, broadcast } = fakeCtx()
    permissionResponse(ctx, fakeConn(null), {
      type: 'permission_response',
      requestId: 'req-none',
      decision: 'deny',
    })
    expect(updateStatus).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
