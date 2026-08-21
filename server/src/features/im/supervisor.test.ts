/**
 * The supervisor decides what actually happens to a message from a chat.
 *
 * Driven end to end through a fake provider, because the properties that matter
 * are behavioural: which messages are answered at all, that one thread never
 * runs two turns at once, that a repeat delivery is not answered twice, that a
 * refused or failed turn still says something back, and that nothing outbound
 * escapes the guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resolveImProvider } from './registry.js'
import {
  acknowledgeOutbound,
  createRobot,
  listTurns,
  resetRobotStoreForTests,
  setRobotEnabled,
  updateRobot,
  type CreateRobotInput,
} from './robot-store.js'
import {
  reloadRobot,
  robotConnectionStatus,
  startImSupervisor,
  stopImSupervisor,
} from './supervisor.js'
import type { ImConnection, ImInboundMessage, ImProvider } from './types.js'
import type { RobotTurnResult } from '../../wiring/robot-turn.js'

vi.mock('./registry.js', () => ({ resolveImProvider: vi.fn() }))

let home: string
/** Messages the fake platform received. */
let sent: { chatId: string; text: string; replyTo?: string }[]
/** Push an inbound message into the supervisor, as the platform would. */
let push: (m: ImInboundMessage) => void
let closed: boolean

function fakeProvider(): ImProvider {
  const connection: ImConnection = {
    status: () => ({ state: 'connected', reconnectAttempts: 0 }),
    send: (chatId, out) => {
      sent.push({ chatId, text: out.text, ...(out.replyTo ? { replyTo: out.replyTo } : {}) })
      return Promise.resolve({ messageId: `out-${sent.length}` })
    },
    close: () => {
      closed = true
      return Promise.resolve()
    },
  }
  return {
    platform: 'feishu',
    capabilities: {
      outboundLongPoll: true,
      threads: true,
      inboundDedup: false,
      maxOutboundChars: 4000,
    },
    connect: (input) => {
      push = input.onMessage
      return Promise.resolve(connection)
    },
  }
}

const turnResult = vi.fn<(...a: unknown[]) => Promise<RobotTurnResult>>()

function message(over: Partial<ImInboundMessage> = {}): ImInboundMessage {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    chatId: 'oc_1',
    chatType: 'group',
    senderId: 'ou_user',
    text: 'build status?',
    mentionedBot: true,
    createdAt: Date.now(),
    ...over,
  }
}

const robotInput = (over: Partial<CreateRobotInput> = {}): CreateRobotInput => ({
  name: 'helper',
  platform: 'feishu',
  appId: 'cli_app',
  appSecret: 'secret',
  vendor: 'claude',
  agentId: 'agent-1',
  ...over,
})

/**
 * Create an enabled robot and bring the supervisor up around it. Connecting is
 * asynchronous, so this waits for the link before the test pushes anything.
 */
async function boot(over: Partial<CreateRobotInput> = {}): Promise<string> {
  const robot = createRobot(robotInput(over))
  acknowledgeOutbound(robot.id)
  setRobotEnabled(robot.id, true)
  startImSupervisor({ runTurn: turnResult as never })
  await settle()
  return robot.id
}

/** Let the supervisor's in-flight promise chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-im-sup-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  process.env.C3_DIR = home
  resetDbForTests()
  resetRobotStoreForTests()
  sent = []
  closed = false
  vi.mocked(resolveImProvider).mockReturnValue(fakeProvider())
  turnResult.mockReset()
  turnResult.mockResolvedValue({
    outcome: 'complete',
    sessionId: 'sess-1',
    lastMessage: 'the build is green',
  })
})

afterEach(async () => {
  await stopImSupervisor(0)
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetRobotStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

describe('response policy — which messages are answered at all', () => {
  it('answers a group message that mentions the robot', async () => {
    await boot()
    push(message())
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ chatId: 'oc_1', text: 'the build is green' })
  })

  it('ignores a group message that does not mention it, by default', async () => {
    await boot()
    push(message({ mentionedBot: false }))
    await settle()
    expect(sent).toEqual([])
    expect(turnResult).not.toHaveBeenCalled()
  })

  it('answers any group message once the mention requirement is lifted', async () => {
    const id = await boot()
    updateRobot(id, { requireMention: false })
    push(message({ mentionedBot: false }))
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('ignores groups outside a non-empty chat allowlist', async () => {
    const id = await boot()
    updateRobot(id, { chatAllowlist: ['oc_allowed'] })
    push(message({ chatId: 'oc_other' }))
    await settle()
    expect(sent).toEqual([])
  })

  it('ignores direct messages by default', async () => {
    await boot()
    push(message({ chatType: 'p2p', mentionedBot: false }))
    await settle()
    expect(sent).toEqual([])
  })

  it('answers a direct message from an allowlisted user when configured', async () => {
    const id = await boot()
    updateRobot(id, { dmMode: 'allowlist', dmAllowlist: ['ou_user'] })
    push(message({ chatType: 'p2p', mentionedBot: false }))
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('stops answering as soon as the robot is disabled', async () => {
    const id = await boot()
    setRobotEnabled(id, false)
    push(message())
    await settle()
    expect(sent).toEqual([])
  })
})

describe('one thread runs one turn at a time', () => {
  it('tells the asker to wait instead of starting a parallel run, and audits busy', async () => {
    const id = await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )

    push(message({ messageId: 'm1' }))
    await settle()
    push(message({ messageId: 'm2' }))
    await settle()

    expect(turnResult).toHaveBeenCalledTimes(1)
    expect(sent.at(-1)?.text).toContain('稍后再问我')
    const busyLog = listTurns(id).find((t) => t.outcome === 'busy')
    expect(busyLog).toMatchObject({
      outcome: 'busy',
      outboundChars: sent.at(-1)!.text.length,
    })

    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
  })

  it('runs different threads concurrently', async () => {
    await boot()
    turnResult.mockReturnValue(new Promise<RobotTurnResult>(() => {}))
    push(message({ messageId: 'm1', chatId: 'oc_a' }))
    push(message({ messageId: 'm2', chatId: 'oc_b' }))
    await settle()
    expect(turnResult).toHaveBeenCalledTimes(2)
  })
})

describe('a redelivered message is not answered twice', () => {
  it('ignores the same message id arriving again on the same thread', async () => {
    await boot()
    const m = message({ messageId: 'm-dup' })
    push(m)
    await settle()
    push(m)
    await settle()
    expect(turnResult).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })
})

describe('a thread reads as one conversation', () => {
  it('resumes the bound session on the next message', async () => {
    await boot()
    push(message({ messageId: 'm1' }))
    await settle()
    push(message({ messageId: 'm2' }))
    await settle()

    expect(turnResult.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
    expect(turnResult.mock.calls[1]?.[0]).toMatchObject({ sessionId: 'sess-1' })
  })

  it('runs in the robot own directory, not a workspace', async () => {
    await boot()
    push(message())
    await settle()
    const arg = turnResult.mock.calls[0]?.[0] as { workspacePath: string }
    expect(arg.workspacePath).toContain(join('robots', 'helper'))
  })
})

describe('every accepted message ends in a reply or an audited reason', () => {
  it('reports a blocked turn instead of going silent', async () => {
    await boot()
    turnResult.mockResolvedValue({
      outcome: 'blocked',
      sessionId: 'sess-1',
      lastMessage: '',
      detail: 'permission requested',
    })
    push(message())
    await settle()
    expect(sent.at(-1)?.text).toContain('人工授权')
  })

  it('reports a timeout', async () => {
    await boot()
    turnResult.mockResolvedValue({ outcome: 'timeout', sessionId: 's', lastMessage: '' })
    push(message())
    await settle()
    expect(sent.at(-1)?.text).toContain('超时')
  })

  it('audits the outcome of every turn', async () => {
    const id = await boot()
    push(message())
    await settle()
    const [log] = listTurns(id)
    expect(log).toMatchObject({ outcome: 'complete', outboundChars: 'the build is green'.length })
  })

  it('treats a complete turn with no text as a failure rather than sending nothing', async () => {
    const id = await boot()
    turnResult.mockResolvedValue({ outcome: 'complete', sessionId: 's', lastMessage: '   ' })
    push(message())
    await settle()
    expect(sent).toHaveLength(1)
    expect(listTurns(id)[0]?.outcome).toBe('error')
  })
})

describe('the outbound guard is on the delivery path', () => {
  it('refuses to send an answer carrying a credential shape, and audits the intercept notice length', async () => {
    const id = await boot()
    turnResult.mockResolvedValue({
      outcome: 'complete',
      sessionId: 's',
      lastMessage: 'the key is ghp_abcdefghijklmnopqrstuvwxyz012345',
    })
    push(message())
    await settle()

    expect(sent.at(-1)?.text).not.toContain('ghp_')
    expect(sent.at(-1)?.text).toContain('凭据')
    expect(listTurns(id)[0]).toMatchObject({
      outcome: 'guard_refused',
      outboundChars: sent.at(-1)!.text.length,
    })
  })

  it('does not deliver when the robot is disabled after the turn completes', async () => {
    const id = await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )
    push(message())
    await settle()
    setRobotEnabled(id, false)
    release({ outcome: 'complete', sessionId: 's', lastMessage: 'should not leave' })
    await settle()
    expect(sent).toEqual([])
    expect(listTurns(id)[0]).toMatchObject({ outcome: 'guard_refused', outboundChars: 0 })
  })

  it('does not deliver when the chat leave the allowlist before send', async () => {
    const id = await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )
    push(message({ chatId: 'oc_1' }))
    await settle()
    updateRobot(id, { chatAllowlist: ['oc_other'] })
    release({ outcome: 'complete', sessionId: 's', lastMessage: 'should not leave' })
    await settle()
    expect(sent).toEqual([])
    expect(listTurns(id)[0]).toMatchObject({
      outcome: 'guard_refused',
      outboundChars: 0,
      error: 'chat_not_allowed',
    })
  })

  it('routes blocked / timeout / error notices through the same path with real outboundChars', async () => {
    const id = await boot()
    for (const [outcome, needle] of [
      ['blocked', '人工授权'],
      ['timeout', '超时'],
      ['error', '出错'],
    ] as const) {
      sent.length = 0
      turnResult.mockResolvedValueOnce({
        outcome,
        sessionId: 's',
        lastMessage: '',
        detail: outcome,
      })
      push(message({ messageId: `m-${outcome}-${Date.now()}` }))
      await settle()
      expect(sent).toHaveLength(1)
      expect(sent[0]?.text).toContain(needle)
      const log = listTurns(id).find((t) => t.outcome === outcome)
      expect(log).toMatchObject({
        outcome,
        outboundChars: sent[0]!.text.length,
      })
    }
  })
})

describe('no raw IM send bypass outside the guard and providers', () => {
  it('keeps connection.send / FeishuApi.sendText out of supervisor and store', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    for (const name of ['supervisor.ts', 'robot-store.ts', 'index.ts', 'registry.ts']) {
      const src = readFileSync(join(here, name), 'utf8')
      expect(src).not.toMatch(/connection\.send\s*\(/)
      expect(src).not.toMatch(/FeishuApi/)
      expect(src).not.toMatch(/\.sendText\s*\(/)
    }
    // Guard is allowed to call the injected rawSend; providers own platform send.
    const guard = readFileSync(join(here, 'outbound-guard.ts'), 'utf8')
    expect(guard).toContain('rawSend')
    expect(guard).not.toMatch(/FeishuApi/)
  })
})

describe('lifecycle', () => {
  it('reports the live connection state', async () => {
    const id = await boot()
    expect(robotConnectionStatus(id)).toMatchObject({ state: 'connected' })
  })

  it('closes connections on stop', async () => {
    await boot()
    await stopImSupervisor(0)
    expect(closed).toBe(true)
  })

  it('stops delivering after stop', async () => {
    await boot()
    const deliverAfterStop = push
    await stopImSupervisor(0)
    deliverAfterStop(message())
    await settle()
    expect(sent).toEqual([])
  })

  it('drops the connection when a robot is disabled and reloaded', async () => {
    const id = await boot()
    setRobotEnabled(id, false)
    await reloadRobot(id)
    expect(closed).toBe(true)
    expect(robotConnectionStatus(id)).toBeUndefined()
  })
})
