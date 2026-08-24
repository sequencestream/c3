import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, ImRobot } from '@ccc/shared/protocol'
import { idleFeishuAppRegistration, isFeishuRegistrationActive } from './state'
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
  const feishuAppRegistration = ref(idleFeishuAppRegistration())
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
    feishuAppRegistration,
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
    feishuAppRegistration,
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

describe('one-click app registration actions', () => {
  it('starts a registration with a client-generated requestId', () => {
    const c = makeCtx()
    c.ctx.startFeishuAppRegistration('feishu')
    const sent = c.send.mock.calls[0][0] as Extract<
      ClientToServer,
      { type: 'start_app_registration' }
    >
    expect(sent.type).toBe('start_app_registration')
    expect(sent.platform).toBe('feishu')
    expect(sent.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(c.feishuAppRegistration.value.phase).toBe('starting')
    expect(c.feishuAppRegistration.value.requestId).toBe(sent.requestId)
  })

  it('does not mint a second request while one is active', () => {
    const c = makeCtx()
    c.ctx.startFeishuAppRegistration('feishu')
    const first = c.send.mock.calls[0][0]
    c.ctx.startFeishuAppRegistration('feishu')
    expect(c.send.mock.calls).toHaveLength(1)
    expect(c.feishuAppRegistration.value.requestId).toBe((first as { requestId: string }).requestId)
    expect(isFeishuRegistrationActive(c.feishuAppRegistration.value)).toBe(true)
  })

  it('cancel sends the wire cancel and clears the view state', () => {
    const c = makeCtx()
    c.ctx.startFeishuAppRegistration('feishu')
    const first = c.send.mock.calls[0][0] as { requestId: string }
    c.ctx.cancelFeishuAppRegistration()
    expect(c.send.mock.calls[1][0]).toEqual({
      type: 'cancel_app_registration',
      requestId: first.requestId,
    })
    expect(c.feishuAppRegistration.value.phase).toBe('idle')
    expect(c.feishuAppRegistration.value.requestId).toBeNull()
  })

  it('clear drops local state without sending a wire message', () => {
    const c = makeCtx()
    c.ctx.startFeishuAppRegistration('feishu')
    c.ctx.clearFeishuAppRegistration()
    expect(c.send.mock.calls).toHaveLength(1)
    expect(c.feishuAppRegistration.value.phase).toBe('idle')
  })
})
