import { describe, expect, it, vi } from 'vitest'
import { DshApprovalBridge } from './approval.js'

describe('DshApprovalBridge', () => {
  it('maps allow to allowed-once', async () => {
    const bridge = new DshApprovalBridge()
    bridge.onRequest(async () => ({ behavior: 'allow' as const }))
    await expect(bridge.resolveApproval('write', {}, new AbortController().signal)).resolves.toBe(
      'allowed-once',
    )
  })

  it('rejects when handler denies', async () => {
    const bridge = new DshApprovalBridge()
    bridge.onRequest(async () => ({ behavior: 'deny' as const, reason: 'no' }))
    await expect(bridge.resolveApproval('write', {}, new AbortController().signal)).resolves.toBe(
      'rejected',
    )
  })

  it('returns cancelled when aborted before handler', async () => {
    const bridge = new DshApprovalBridge()
    const controller = new AbortController()
    controller.abort()
    bridge.onRequest(vi.fn())
    await expect(bridge.resolveApproval('write', {}, controller.signal)).resolves.toBe('cancelled')
  })
})
