import { describe, expect, it } from 'vitest'
import type { ImRobot } from '@ccc/shared/protocol'
import { computeWriteConfigHash, writeGrantConfigAcknowledged } from './write-config-hash.js'

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

describe('write config hash', () => {
  it('changes when config revision increments', () => {
    const a = computeWriteConfigHash(base())
    const b = computeWriteConfigHash({ ...base(), configRevision: 1 })
    expect(a).not.toBe(b)
  })

  it('changes when tool allowlist changes', () => {
    const a = computeWriteConfigHash(base())
    const b = computeWriteConfigHash({ ...base(), toolAllowlist: ['Write'] })
    expect(a).not.toBe(b)
  })

  it('grant ack valid only when stored hash matches live config', () => {
    const robot = base()
    const hash = computeWriteConfigHash(robot)
    expect(writeGrantConfigAcknowledged(robot, hash)).toBe(true)
    expect(writeGrantConfigAcknowledged({ ...robot, configRevision: 1 }, hash)).toBe(false)
  })
})
