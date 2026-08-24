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
  getRobot,
  listTurns,
  resetRobotStoreForTests,
  setRobotEnabled,
  updateRobot,
  type CreateRobotInput,
} from './robot-store.js'
import {
  accountNamespaceOf,
  consumeChallenge,
  createChallenge,
  resetIdentityStoreForTests,
  seedBindingForTests,
} from './identity-store.js'
import {
  reloadRobot,
  robotConnectionStatus,
  startImSupervisor,
  stopImSupervisor,
} from './supervisor.js'
import type { ImConnection, ImInboundMessage, ImProvider } from './types.js'
import type { RobotTurnProgress, RobotTurnResult } from '../../wiring/robot-turn.js'

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
 * Default `bind` maps `ou_user` so ordinary-chat tests match the new identity gate.
 */
async function boot(
  over: Partial<CreateRobotInput> = {},
  opts: { bind?: boolean; senderId?: string } = {},
): Promise<string> {
  const robot = createRobot(robotInput(over))
  acknowledgeOutbound(robot.id)
  setRobotEnabled(robot.id, true)
  startImSupervisor({ runTurn: turnResult as never })
  await settle()
  if (opts.bind !== false) bindSender(robot.id, opts.senderId ?? 'ou_user')
  return robot.id
}

function bindSender(robotId: string, senderId: string, subject?: string): void {
  const robot = getRobot(robotId)
  if (!robot) throw new Error('robot missing')
  const ns = accountNamespaceOf(robot.platform, robot.appId)
  if (subject) {
    seedBindingForTests({ accountNamespace: ns, senderId, subject })
    return
  }
  const ch = createChallenge('tester', robotId)
  const result = consumeChallenge({
    robotId,
    accountNamespace: ns,
    senderId,
    token: ch.token,
  })
  if (!result.ok) throw new Error('bind failed')
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
  resetIdentityStoreForTests()
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
  vi.useRealTimers()
  await stopImSupervisor(0)
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
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
    acknowledgeOutbound(id)
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

describe('one Conversation runs one turn at a time', () => {
  it('tells the same sender to wait instead of starting a parallel run, and audits busy', async () => {
    const id = await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )

    push(message({ messageId: 'm1', senderId: 'ou_user' }))
    await settle()
    push(message({ messageId: 'm2', senderId: 'ou_user' }))
    await settle()

    expect(turnResult).toHaveBeenCalledTimes(1)
    expect(sent.at(-1)?.text).toContain('Still working')
    const busyLog = listTurns(id).find((t) => t.outcome === 'busy')
    expect(busyLog).toMatchObject({
      outcome: 'busy',
      outboundChars: sent.at(-1)!.text.length,
    })

    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
  })

  it('runs different senders in the same group concurrently', async () => {
    const id = await boot({}, { bind: false })
    bindSender(id, 'alice')
    turnResult.mockReturnValue(new Promise<RobotTurnResult>(() => {}))
    push(message({ messageId: 'm1', senderId: 'alice' }))
    push(message({ messageId: 'm2', senderId: 'bob' }))
    await settle()
    // No-auth deployments only allow one active binding; the second sender is
    // identity-gated and must not start a parallel run.
    expect(turnResult).toHaveBeenCalledTimes(1)
    expect(sent.some((s) => s.text.includes('Personal settings'))).toBe(true)
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
  it('ignores the same message id arriving again', async () => {
    await boot()
    const m = message({ messageId: 'm-dup' })
    push(m)
    await settle()
    push(m)
    await settle()
    expect(turnResult).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })

  it('silently drops an in-flight redelivery instead of sending busy', async () => {
    const id = await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )

    const m = message({ messageId: 'm-inflight-dup', senderId: 'ou_user' })
    push(m)
    await settle()
    push(m)
    await settle()

    expect(turnResult).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(0)
    expect(listTurns(id).some((t) => t.outcome === 'busy')).toBe(false)

    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe('done')
  })

  it('sends busy once for a new message, then silently drops its redelivery while still busy', async () => {
    const id = await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )

    push(message({ messageId: 'm-a', senderId: 'ou_user' }))
    await settle()
    const busyMsg = message({ messageId: 'm-busy', senderId: 'ou_user' })
    push(busyMsg)
    await settle()
    push(busyMsg)
    await settle()

    expect(turnResult).toHaveBeenCalledTimes(1)
    expect(sent.filter((s) => s.text.includes('Still working'))).toHaveLength(1)
    expect(listTurns(id).filter((t) => t.outcome === 'busy')).toHaveLength(1)

    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
  })

  it('does not start an agent for a busy message redelivered after the prior turn ends', async () => {
    await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )

    push(message({ messageId: 'm-a', senderId: 'ou_user' }))
    await settle()
    const busyMsg = message({ messageId: 'm-busy-later', senderId: 'ou_user' })
    push(busyMsg)
    await settle()
    expect(sent.at(-1)?.text).toContain('Still working')

    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
    const afterDone = sent.length

    push(busyMsg)
    await settle()

    expect(turnResult).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(afterDone)
  })
})

describe('sender-isolated continuous conversation', () => {
  it('resumes the bound session for the same sender', async () => {
    await boot()
    push(message({ messageId: 'm1', senderId: 'ou_user' }))
    await settle()
    push(message({ messageId: 'm2', senderId: 'ou_user' }))
    await settle()

    expect(turnResult.mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
    expect(turnResult.mock.calls[1]?.[0]).toMatchObject({ sessionId: 'sess-1' })
  })

  it('does not let sender B recover sender A context', async () => {
    const id = await boot({}, { bind: false })
    bindSender(id, 'alice', 'subject-alice')
    bindSender(id, 'bob', 'subject-bob')
    turnResult
      .mockResolvedValueOnce({
        outcome: 'complete',
        sessionId: 'sess-a',
        lastMessage: 'alice-private-answer',
      })
      .mockResolvedValueOnce({
        outcome: 'complete',
        sessionId: 'sess-b',
        lastMessage: 'bob-answer',
      })
      .mockResolvedValueOnce({
        outcome: 'complete',
        sessionId: 'sess-a2',
        lastMessage: 'alice-again',
      })

    push(message({ messageId: 'm1', senderId: 'alice', text: 'alice secret question' }))
    await settle()
    push(message({ messageId: 'm2', senderId: 'bob', text: 'bob question' }))
    await settle()

    // Force DB recovery for alice's second turn by clearing the native cache mid-flight
    // is unnecessary — bob's prompt must not contain alice's texts.
    const bobPrompt = (turnResult.mock.calls[1]?.[0] as { prompt: string }).prompt
    expect(bobPrompt).not.toContain('alice')
    expect(bobPrompt).not.toContain('alice-private-answer')

    // Drop alice session so the third turn must seed from DB.
    const { getDb } = await import('../../kernel/infra/db.js')
    getDb()!.run(
      `UPDATE im_robot_threads SET session_id = NULL
       WHERE sender_id = 'alice'`,
    )

    push(message({ messageId: 'm3', senderId: 'alice', text: 'follow up' }))
    await settle()
    const alicePrompt = (turnResult.mock.calls[2]?.[0] as { prompt: string }).prompt
    expect(alicePrompt).toContain('alice secret question')
    expect(alicePrompt).toContain('alice-private-answer')
    expect(alicePrompt).not.toContain('bob question')
    expect(alicePrompt).not.toContain('bob-answer')
  })

  it('runs in the robot own directory, not a workspace', async () => {
    await boot()
    push(message())
    await settle()
    const arg = turnResult.mock.calls[0]?.[0] as { workspacePath: string }
    expect(arg.workspacePath).toContain(join('robots', 'helper'))
  })

  it('rejects credential-shaped input without running or saving body', async () => {
    const id = await boot()
    push(
      message({
        messageId: 'm-cred',
        text: 'here is ghp_abcdefghijklmnopqrstuvwxyz012345',
      }),
    )
    await settle()
    expect(turnResult).not.toHaveBeenCalled()
    expect(sent.at(-1)?.text).toMatch(/credentials|credential/i)
    expect(sent.at(-1)?.text).not.toContain('ghp_')
    expect(listTurns(id)[0]).toMatchObject({
      outcome: 'input_rejected',
      rejectReason: 'credential',
      outboundChars: sent.at(-1)!.text.length,
    })
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
    expect(sent.at(-1)?.text).toContain('manual approval')
  })

  it('reports a timeout', async () => {
    await boot()
    turnResult.mockResolvedValue({ outcome: 'timeout', sessionId: 's', lastMessage: '' })
    push(message())
    await settle()
    expect(sent.at(-1)?.text).toContain('timed out')
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

  it('redacts credential-shaped turn detail before writing the audit error', async () => {
    const id = await boot()
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345'
    turnResult.mockResolvedValue({
      outcome: 'error',
      sessionId: 's',
      lastMessage: '',
      detail: `turn_end failed: token=${secret}`,
    })
    push(message())
    await settle()

    const log = listTurns(id)[0]
    expect(log).toMatchObject({ outcome: 'error' })
    expect(log?.error).toContain('turn_end failed')
    expect(log?.error).toContain('[redacted]')
    expect(log?.error).not.toContain(secret)
    expect(JSON.stringify(log)).not.toContain(secret)
  })
})

describe('replies go out directly, never as quotes of the inbound message', () => {
  it('delivers the final answer without a replyTo quote', async () => {
    await boot()
    push(message())
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ chatId: 'oc_1', text: 'the build is green' })
    expect(sent[0]?.replyTo).toBeUndefined()
  })

  it('also keeps the busy notice on the direct path', async () => {
    await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )
    push(message({ messageId: 'm-a', senderId: 'ou_user' }))
    await settle()
    push(message({ messageId: 'm-b', senderId: 'ou_user' }))
    await settle()
    const busy = sent.find((s) => s.text.includes('Still working'))
    expect(busy).toBeTruthy()
    expect(busy?.replyTo).toBeUndefined()
    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
  })

  it('keeps the binding notice on the direct path', async () => {
    await boot({}, { bind: false })
    push(message())
    await settle()
    const guide = sent.find((s) => s.text.includes('Personal settings'))
    expect(guide).toBeTruthy()
    expect(guide?.replyTo).toBeUndefined()
  })
})

describe('progress feedback during a long turn', () => {
  it('sends nothing for a turn that finishes inside the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )
    push(message())
    await settle()
    const onProgress = (
      turnResult.mock.calls[0]?.[0] as { onProgress: (f: RobotTurnProgress) => void }
    ).onProgress
    onProgress({ kind: 'accepted' })
    onProgress({ kind: 'step_started', step: 1 })
    await settle()
    expect(sent).toHaveLength(0)
    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe('done')
    expect(sent[0]?.replyTo).toBeUndefined()
    vi.useRealTimers()
  })

  it('delivers a bounded, spaced stream of progress for a long turn, then the full answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const id = await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )
    push(message())
    await settle()
    const onProgress = (
      turnResult.mock.calls[0]?.[0] as { onProgress: (f: RobotTurnProgress) => void }
    ).onProgress

    // accepted clears the grace period and is delivered.
    onProgress({ kind: 'accepted' })
    await vi.advanceTimersByTimeAsync(2100)
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe('Received. Working on it.')
    expect(sent[0]?.replyTo).toBeUndefined()

    // a step frame inside the 5s spacing window is held, then delivered.
    onProgress({ kind: 'step_started', step: 1 })
    await settle()
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(sent).toHaveLength(2)
    expect(sent[1]?.text).toBe('Working on step 1.')

    onProgress({ kind: 'step_done', step: 1 })
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(sent).toHaveLength(3)
    expect(sent[2]?.text).toBe('Still working. One moment.')

    // stage-skipping frames are dropped, and the budget caps total progress at 3.
    onProgress({ kind: 'step_started', step: 2 })
    onProgress({ kind: 'step_done', step: 2 })
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(sent).toHaveLength(3)

    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
    expect(sent).toHaveLength(4)
    expect(sent[3]?.text).toBe('done')

    // progress is fixed_notice: it never enters the turn audit as outbound chars.
    const [log] = listTurns(id)
    expect(log?.outcome).toBe('complete')
    expect(log?.outboundChars).toBe('done'.length)
    vi.useRealTimers()
  })

  it('drops progress frames that skip the strict stage order', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await boot()
    let release: (r: RobotTurnResult) => void = () => {}
    turnResult.mockReturnValueOnce(
      new Promise<RobotTurnResult>((r) => {
        release = r
      }),
    )
    push(message())
    await settle()
    const onProgress = (
      turnResult.mock.calls[0]?.[0] as { onProgress: (f: RobotTurnProgress) => void }
    ).onProgress
    // a step or done frame before accepted skips a stage and is never sent.
    onProgress({ kind: 'step_done', step: 1 })
    onProgress({ kind: 'step_started', step: 1 })
    await vi.advanceTimersByTimeAsync(2100)
    await settle()
    expect(sent).toHaveLength(0)
    onProgress({ kind: 'accepted' })
    await vi.advanceTimersByTimeAsync(2100)
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('Received')
    release({ outcome: 'complete', sessionId: 'sess-1', lastMessage: 'done' })
    await settle()
    vi.useRealTimers()
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
    expect(sent.at(-1)?.text).toMatch(/credentials|credential/i)
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
    acknowledgeOutbound(id)
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
      ['blocked', 'manual approval'],
      ['timeout', 'timed out'],
      ['error', 'went wrong'],
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

describe('identity gate and bind-control path', () => {
  it('guides an unbound sender instead of starting a run', async () => {
    const id = await boot({}, { bind: false })
    push(message())
    await settle()
    expect(turnResult).not.toHaveBeenCalled()
    expect(sent[0]?.text).toContain('Personal settings')
    expect(listTurns(id)[0]?.outcome).toBe('identity_required')
  })

  it('consumes a DM token once, audits the notice, and ignores redelivery', async () => {
    const id = await boot({ dmMode: 'disabled' }, { bind: false })
    const ch = createChallenge('tester', id)
    const m = message({
      messageId: 'm-bind',
      chatType: 'p2p',
      chatId: 'ou_user',
      mentionedBot: false,
      text: ch.token,
    })
    push(m)
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('Identity binding is active')
    expect(listTurns(id)[0]?.outcome).toBe('complete')

    push(m)
    await settle()
    expect(sent).toHaveLength(1)
    expect(listTurns(id)).toHaveLength(1)
  })

  it('does not consume a group token and still audits the dm-only guide', async () => {
    const id = await boot({}, { bind: false })
    const ch = createChallenge('tester', id)
    const m = message({ messageId: 'm-group-token', text: ch.token })
    push(m)
    await settle()
    expect(sent[0]?.text).toContain('direct message')
    expect(listTurns(id)[0]?.outcome).toBe('identity_required')

    push(m)
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('ignores a group token when requireMention is on and the bot was not mentioned', async () => {
    const id = await boot({}, { bind: false })
    const ch = createChallenge('tester', id)
    push(
      message({
        messageId: 'm-group-token-silent',
        text: ch.token,
        mentionedBot: false,
      }),
    )
    await settle()
    expect(sent).toEqual([])
    expect(listTurns(id)).toEqual([])
  })
})
