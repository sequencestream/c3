import { describe, expect, it } from 'vitest'
import type { ImRobot } from '@ccc/shared/protocol'
import { computeOutboundConfigHash, outboundConfigAcknowledged } from './outbound-config-hash.js'

const base = (): ImRobot => ({
  id: 'r1',
  name: 'bot',
  platform: 'feishu',
  appId: 'app',
  hasSecret: true,
  vendor: 'claude',
  agentId: 'a1',
  mode: '',
  toolAllowlist: [],
  requireMention: true,
  chatAllowlist: ['oc_1'],
  dmMode: 'disabled',
  dmAllowlist: [],
  maxTurnMs: null,
  enabled: true,
  outboundAckAt: 1,
  outboundAckHash: null,
  broadcastEventTypes: [],
  broadcastToBoundUsers: false,
  broadcastGroupChatIds: [],
  locale: null,
  configRevision: 0,
  writeGrants: [],
  createdAt: 0,
  updatedAt: 0,
})

describe('outbound config hash', () => {
  it('changes when L0 broadcast config changes', () => {
    const a = computeOutboundConfigHash(base())
    const b = computeOutboundConfigHash({
      ...base(),
      broadcastEventTypes: ['intent_parked'],
    })
    expect(a).not.toBe(b)
  })

  it('ack is valid only when stored hash matches live config', () => {
    const robot = base()
    const hash = computeOutboundConfigHash(robot)
    expect(outboundConfigAcknowledged({ ...robot, outboundAckHash: hash })).toBe(true)
    expect(outboundConfigAcknowledged({ ...robot, outboundAckHash: 'stale' })).toBe(false)
  })
})
