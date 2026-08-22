import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import type { ImRobot, ImRobotWriteGrant } from '@ccc/shared/protocol'
import RobotWriteGrants from './RobotWriteGrants.vue'

function grant(
  capability: ImRobotWriteGrant['capability'],
  status: ImRobotWriteGrant['status'],
): ImRobotWriteGrant {
  return {
    robotId: 'r1',
    capability,
    status,
    enabled: status === 'active',
    acknowledgedBy: status === 'active' ? 'admin' : null,
    writeAckAt: status === 'active' ? 1 : null,
    configHash: status === 'active' ? 'hash' : null,
    updatedAt: 1,
  }
}

function robot(over: Partial<ImRobot> = {}): ImRobot {
  return {
    id: 'r1',
    name: 'helper',
    platform: 'feishu',
    appId: 'cli_app',
    hasSecret: true,
    vendor: 'claude',
    agentId: 'agent-1',
    mode: 'robot',
    toolAllowlist: [],
    requireMention: true,
    chatAllowlist: [],
    dmMode: 'open',
    dmAllowlist: [],
    maxTurnMs: null,
    enabled: true,
    outboundAckAt: 1,
    outboundAckHash: 'out',
    broadcastEventTypes: [],
    broadcastToBoundUsers: false,
    broadcastGroupChatIds: [],
    locale: null,
    configRevision: 0,
    writeGrants: [
      grant('queue_respond', 'unauthorized'),
      grant('automation_control', 'active'),
      grant('annotate', 'disabled'),
    ],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('RobotWriteGrants', () => {
  it('shows acknowledge for unauthorized and enable for disabled', () => {
    const w = mount(RobotWriteGrants, { props: { robot: robot() } })
    expect(w.find('[data-testid="grant-ack-queue_respond"]').exists()).toBe(true)
    expect(w.find('[data-testid="grant-enable-annotate"]').exists()).toBe(true)
    expect(w.find('[data-testid="grant-disable-automation_control"]').exists()).toBe(true)
  })

  it('emits acknowledge after confirm dialog', async () => {
    const w = mount(RobotWriteGrants, { props: { robot: robot() } })
    await w.get('[data-testid="grant-ack-queue_respond"]').trigger('click')
    w.findComponent(ConfirmDialog).vm.$emit('confirm')
    expect(w.emitted('acknowledge')?.[0]).toEqual(['queue_respond'])
  })

  it('emits set-enabled for disable', async () => {
    const w = mount(RobotWriteGrants, { props: { robot: robot() } })
    await w.get('[data-testid="grant-disable-automation_control"]').trigger('click')
    expect(w.emitted('set-enabled')?.[0]).toEqual(['automation_control', false])
  })
})
