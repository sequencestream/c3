import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, ImRobot } from '@ccc/shared/protocol'
import { installRobotActions } from './robot-actions'
import type { AppCtx } from './types'

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
    writeGrants: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function makeCtx(isAdmin = true) {
  const send = vi.fn<(message: ClientToServer) => void>()
  const selectedRobotId = ref<string | null>(null)
  const robotTurns = ref([{ id: 'stale' }])
  const imIdentityBindings = ref([{ id: 'stale' }])
  const imGroupWorkspaceScopes = ref([{ chatId: 'stale' }])
  const imGroupScopeChatId = ref('stale')
  const ctx = {
    send,
    client: {},
    auth: { isAdmin: ref(isAdmin) },
    robots: ref([robot()]),
    selectedRobotId,
    robotTurns,
    imIdentityBindings,
    imGroupWorkspaceScopes,
    imGroupScopeChatId,
  } as unknown as AppCtx

  installRobotActions(ctx)
  return {
    ctx,
    send,
    selectedRobotId,
    robotTurns,
    imIdentityBindings,
    imGroupWorkspaceScopes,
    imGroupScopeChatId,
  }
}

describe('robot selection refresh', () => {
  it('immediately requests the selected robot recent turns and clears prior detail data', () => {
    const c = makeCtx()
    c.ctx.selectRobot('r1')

    expect(c.selectedRobotId.value).toBe('r1')
    expect(c.robotTurns.value).toEqual([])
    expect(c.imIdentityBindings.value).toEqual([])
    expect(c.imGroupWorkspaceScopes.value).toEqual([])
    expect(c.imGroupScopeChatId.value).toBe('')
    expect(c.send.mock.calls.map(([message]) => message)).toEqual([
      { type: 'list_robot_turns', robotId: 'r1' },
      { type: 'list_im_identity_bindings', accountNamespace: 'feishu:cli_app' },
    ])
  })

  it('keeps the recent-turn request for non-admins without requesting admin bindings', () => {
    const c = makeCtx(false)
    c.ctx.selectRobot('r1')

    expect(c.send.mock.calls.map(([message]) => message)).toEqual([
      { type: 'list_robot_turns', robotId: 'r1' },
    ])
  })
})
