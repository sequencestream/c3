/**
 * Unit tests for the explicit inbound admission gate sequence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TODO_TOKEN_PREFIX } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import * as callScope from './call-scope.js'
import { evaluateInboundSyncAdmission, processInboundAdmission } from './inbound-admission.js'
import {
  accountNamespaceOf,
  createChallenge,
  resetIdentityStoreForTests,
  seedBindingForTests,
} from './identity-store.js'
import {
  acknowledgeOutbound,
  createRobot,
  getRobot,
  resetRobotStoreForTests,
  setRobotEnabled,
  updateRobot,
} from './robot-store.js'
import type { ImInboundMessage } from './types.js'
import type { RobotHandle } from './supervisor-internal.js'

const sent: { category: string; key?: string }[] = []
const ignored: string[] = []

vi.mock('./im-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./im-log.js')>()
  return {
    ...actual,
    logImInboundIgnored: (_r: unknown, reason: string) => {
      ignored.push(reason)
    },
  }
})

function fakeHandle(): RobotHandle {
  return {
    status: () => ({ state: 'connected', reconnectAttempts: 0 }),
    close: async () => {},
    maxOutboundChars: 4000,
    rawSend: async () => ({ messageId: 'out-1' }),
    sendOutbound: async (content) => {
      if (content.category === 'fixed_notice' || content.category === 'binding_notice') {
        sent.push({
          category: content.category,
          key: 'message' in content ? content.message.key : undefined,
        })
      }
      return { ok: true, outboundChars: 10, messageId: 'out-1', text: 'notice' }
    },
  }
}

function message(over: Partial<ImInboundMessage> = {}): ImInboundMessage {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    chatId: 'oc_1',
    chatType: 'group',
    senderId: 'ou_user',
    text: 'hello',
    mentionedBot: true,
    createdAt: Date.now(),
    ...over,
  }
}

let home: string
let robotId: string
let handle: RobotHandle

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-im-adm-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  process.env.C3_DIR = home
  resetDbForTests()
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  sent.length = 0
  ignored.length = 0
  handle = fakeHandle()
  const robot = createRobot({
    name: 'helper',
    platform: 'feishu',
    appId: 'cli_app',
    appSecret: 'secret',
    vendor: 'claude',
    agentId: 'agent-1',
  })
  robotId = robot.id
  acknowledgeOutbound(robot.id)
  setRobotEnabled(robot.id, true)
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('evaluateInboundSyncAdmission', () => {
  it('rejects when handle is missing', () => {
    const r = getRobot(robotId)!
    const result = evaluateInboundSyncAdmission(undefined, r, message())
    expect(result).toEqual({ kind: 'reject' })
    expect(ignored).toContain('not_connected')
  })

  it('rejects when robot is disabled', () => {
    setRobotEnabled(robotId, false)
    const r = getRobot(robotId)!
    const result = evaluateInboundSyncAdmission(handle, r, message())
    expect(result).toEqual({ kind: 'reject' })
    expect(ignored).toContain('disabled')
  })

  it('rejects blank sender', () => {
    const r = getRobot(robotId)!
    const result = evaluateInboundSyncAdmission(handle, r, message({ senderId: '  ' }))
    expect(result).toEqual({ kind: 'reject' })
    expect(ignored).toContain('blank_sender')
  })

  it('proceeds for a valid inbound message', () => {
    const r = getRobot(robotId)!
    const m = message()
    const result = evaluateInboundSyncAdmission(handle, r, m)
    expect(result).toEqual({ kind: 'proceed', robot: r, handle })
  })
})

describe('processInboundAdmission gate sequence', () => {
  it('rejects store unavailable with a fixed notice', async () => {
    const r = getRobot(robotId)!
    const store = await import('./robot-store.js')
    vi.spyOn(store, 'isStoreAvailable').mockReturnValue(false)
    const result = await processInboundAdmission(r, handle, message())
    expect(result).toEqual({ kind: 'done' })
    expect(ignored).toContain('store_unavailable')
    expect(sent.some((s) => s.key === 'runtime.storeUnavailable')).toBe(true)
  })

  it('silently drops a group todo token when not @mentioned', async () => {
    const r = getRobot(robotId)!
    const todoToken = `${TODO_TOKEN_PREFIX}${'a'.repeat(22)}`
    const result = await processInboundAdmission(
      r,
      handle,
      message({ text: todoToken, mentionedBot: false }),
    )
    expect(result).toEqual({ kind: 'done' })
    expect(ignored).toContain('not_accepted')
  })

  it('lets an unbound p2p todo token reach the control handler outside allowlist', async () => {
    updateRobot(robotId, { dmMode: 'allowlist', dmAllowlist: ['ou_other'] })
    const todoToken = `${TODO_TOKEN_PREFIX}${'b'.repeat(22)}`
    const l2 = await import('./l2-control.js')
    const spy = vi.spyOn(l2, 'handleTodoControl').mockResolvedValue(true)

    const result = await processInboundAdmission(
      getRobot(robotId)!,
      handle,
      message({
        chatType: 'p2p',
        chatId: 'ou_user',
        mentionedBot: false,
        text: todoToken,
      }),
    )

    expect(result).toEqual({ kind: 'done' })
    expect(ignored).not.toContain('not_accepted')
    expect(spy).toHaveBeenCalled()
  })

  it('silently drops a group binding token when not @mentioned', async () => {
    const r = getRobot(robotId)!
    const ch = createChallenge('tester', robotId)
    const result = await processInboundAdmission(
      r,
      handle,
      message({ text: ch.token, mentionedBot: false }),
    )
    expect(result).toEqual({ kind: 'done' })
    expect(ignored).toContain('not_accepted')
  })

  it('guides unbound identity on p2p instead of starting a turn', async () => {
    const r = getRobot(robotId)!
    const result = await processInboundAdmission(
      r,
      handle,
      message({ chatType: 'p2p', chatId: 'ou_user' }),
    )
    expect(result).toEqual({ kind: 'done' })
    expect(sent.some((s) => s.key === 'binding.identityRequired')).toBe(true)
  })

  it('rejects bound sender failing response surface for all chat types', async () => {
    const r = getRobot(robotId)!
    const ns = accountNamespaceOf(r.platform, r.appId)
    seedBindingForTests({ accountNamespace: ns, senderId: 'ou_user', subject: 'tester' })
    const result = await processInboundAdmission(r, handle, message({ mentionedBot: false }))
    expect(result).toEqual({ kind: 'done' })
    expect(ignored).toContain('not_accepted')
  })

  it('audits identity_required when call-scope fails after binding', async () => {
    const r = getRobot(robotId)!
    const ns = accountNamespaceOf(r.platform, r.appId)
    seedBindingForTests({ accountNamespace: ns, senderId: 'ou_user', subject: 'tester' })
    vi.spyOn(callScope, 'resolveCallScope').mockReturnValue({ ok: false, reason: 'unbound' })
    const result = await processInboundAdmission(r, handle, message())
    expect(result).toEqual({ kind: 'done' })
    expect(sent.some((s) => s.key === 'binding.identityRequiredGroup')).toBe(true)
  })

  it('does not call resolveCallScope when identity is unbound', async () => {
    const r = getRobot(robotId)!
    const scopeSpy = vi.spyOn(callScope, 'resolveCallScope')
    await processInboundAdmission(
      r,
      handle,
      message({ chatType: 'p2p', chatId: 'ou_user', text: 'need binding' }),
    )
    expect(scopeSpy).not.toHaveBeenCalled()
  })

  it('proceeds to start_turn when all gates pass', async () => {
    const r = getRobot(robotId)!
    const ns = accountNamespaceOf(r.platform, r.appId)
    seedBindingForTests({ accountNamespace: ns, senderId: 'ou_user', subject: 'tester' })
    const result = await processInboundAdmission(r, handle, message())
    expect(result.kind).toBe('start_turn')
    if (result.kind === 'start_turn') {
      expect(result.threadKey).toBeTruthy()
      expect(result.scope.scopeHash).toBeTruthy()
      expect(result.binding.subject).toBe('tester')
    }
  })

  it('logs duplicate when unbound control message is redelivered', async () => {
    const r = getRobot(robotId)!
    const m = message({ chatType: 'p2p', chatId: 'ou_user', messageId: 'm-dup' })
    await processInboundAdmission(r, handle, m)
    ignored.length = 0
    await processInboundAdmission(r, handle, m)
    expect(ignored).toContain('duplicate')
  })

  it('consumes a p2p binding token even when dmMode is disabled', async () => {
    updateRobot(robotId, { dmMode: 'disabled' })
    const r = getRobot(robotId)!
    const ch = createChallenge('tester', robotId)
    const result = await processInboundAdmission(
      r,
      handle,
      message({
        chatType: 'p2p',
        chatId: 'ou_user',
        mentionedBot: false,
        text: ch.token,
      }),
    )
    expect(result).toEqual({ kind: 'done' })
    expect(ignored).not.toContain('not_accepted')
    expect(sent.some((s) => s.key === 'binding.success')).toBe(true)
  })
})
