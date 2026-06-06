/**
 * OpenCode approval bridge (2026-06-06-003) — the event/REST split's four
 * obligations: write-back on a decision, timeout→deny, retry + stale-404, replied
 * idempotency, and the preApproved (rule-engine auto-allow) classification. The
 * OpenCode client is faked to a single permission write-back endpoint.
 */
import { describe, expect, it } from 'vitest'
import type { OpencodeClient, Permission } from '@opencode-ai/sdk'
import { OpencodeApprovalBridge } from './approval.js'
import type { WriteBackContext } from './approval.js'

function perm(id = 'perm_1', sessionID = 'ses_1'): Permission {
  return {
    id,
    type: 'bash',
    sessionID,
    messageID: 'msg_1',
    title: 'run ls',
    metadata: {},
    time: { created: 0 },
  } as Permission
}

/** A client capturing write-backs; `status` and a one-shot throw are configurable. */
function fakeCtx(opts: { status?: number; throwOnce?: boolean } = {}): {
  ctx: WriteBackContext
  calls: Array<{ id: string; permissionID: string; response: string }>
} {
  const calls: Array<{ id: string; permissionID: string; response: string }> = []
  let threw = false
  const client = {
    postSessionIdPermissionsPermissionId: async (o: {
      path: { id: string; permissionID: string }
      body?: { response: string }
    }) => {
      calls.push({ id: o.path.id, permissionID: o.path.permissionID, response: o.body!.response })
      if (opts.throwOnce && !threw) {
        threw = true
        throw new Error('network blip')
      }
      return { data: undefined, error: undefined, response: { status: opts.status ?? 200 } }
    },
  } as unknown as OpencodeClient
  return { ctx: { client, directory: '/work' }, calls }
}

describe('OpencodeApprovalBridge', () => {
  it('writes back `once` on an allow decision', async () => {
    const bridge = new OpencodeApprovalBridge()
    bridge.onRequest(async () => ({ behavior: 'allow' }))
    const { ctx, calls } = fakeCtx()

    await bridge.handleUpdated(perm(), ctx)

    expect(calls).toEqual([{ id: 'ses_1', permissionID: 'perm_1', response: 'once' }])
  })

  it('writes back `reject` on a deny decision', async () => {
    const bridge = new OpencodeApprovalBridge()
    bridge.onRequest(async () => ({ behavior: 'deny', reason: 'no' }))
    const { ctx, calls } = fakeCtx()

    await bridge.handleUpdated(perm(), ctx)

    expect(calls[0].response).toBe('reject')
  })

  it('default-denies (reject) when no handler is registered', async () => {
    const bridge = new OpencodeApprovalBridge()
    const { ctx, calls } = fakeCtx()

    await bridge.handleUpdated(perm(), ctx)

    expect(calls[0].response).toBe('reject')
  })

  it('times out an unanswered request to a reject write-back', async () => {
    const bridge = new OpencodeApprovalBridge({ timeoutMs: 10 })
    bridge.onRequest(() => new Promise(() => {})) // never resolves
    const { ctx, calls } = fakeCtx()

    await bridge.handleUpdated(perm(), ctx)

    expect(calls[0].response).toBe('reject')
  })

  it('retries a failed write-back with backoff', async () => {
    const bridge = new OpencodeApprovalBridge({ sleep: async () => {}, maxRetries: 2 })
    bridge.onRequest(async () => ({ behavior: 'allow' }))
    const { ctx, calls } = fakeCtx({ throwOnce: true })

    await bridge.handleUpdated(perm(), ctx)

    expect(calls).toHaveLength(2) // first throws, retry succeeds
  })

  it('does not retry on a stale 404', async () => {
    const bridge = new OpencodeApprovalBridge({ sleep: async () => {} })
    bridge.onRequest(async () => ({ behavior: 'allow' }))
    const { ctx, calls } = fakeCtx({ status: 404 })

    await bridge.handleUpdated(perm(), ctx)

    expect(calls).toHaveLength(1) // 404 = give up, no retry
  })

  it('replied idempotency: an external reply settles the pending request, no write-back', async () => {
    const bridge = new OpencodeApprovalBridge()
    // A handler that defers; we settle it via a replied event before it resolves.
    let resolveHandler: () => void = () => {}
    bridge.onRequest(
      () =>
        new Promise((r) => {
          resolveHandler = () => r({ behavior: 'allow' })
        }),
    )
    const { ctx, calls } = fakeCtx()

    const inflight = bridge.handleUpdated(perm(), ctx)
    // Someone else answers first.
    const result = bridge.handleReplied({
      sessionID: 'ses_1',
      permissionID: 'perm_1',
      response: 'once',
    })
    resolveHandler()
    await inflight

    expect(result).toBe('settled')
    expect(calls).toHaveLength(0) // c3 must NOT double-write
  })

  it('classifies a replied for an unknown id as preApproved (rule-engine auto-allow)', () => {
    const bridge = new OpencodeApprovalBridge()
    const result = bridge.handleReplied({
      sessionID: 'ses_1',
      permissionID: 'never_asked',
      response: 'once',
    })
    expect(result).toBe('preApproved')
  })

  it('classifies the self-triggered replied (from c3 own write-back) as self', async () => {
    const bridge = new OpencodeApprovalBridge()
    bridge.onRequest(async () => ({ behavior: 'allow' }))
    const { ctx } = fakeCtx()
    await bridge.handleUpdated(perm('perm_x'), ctx)

    const result = bridge.handleReplied({
      sessionID: 'ses_1',
      permissionID: 'perm_x',
      response: 'once',
    })
    expect(result).toBe('self')
  })
})
