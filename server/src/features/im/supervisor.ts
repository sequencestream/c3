/**
 * The IM supervisor: holds one connection per enabled robot and turns an inbound
 * chat message into one agent turn and one reply.
 *
 * Conversation identity is `(platform, robotId, threadKey, senderId)`. Different
 * senders in the same IM thread never share recoverable context. Context bodies
 * live in the database (ADR-0048); `~/.c3/robots/<name>` is only a run root.
 *
 *  - **One Conversation runs one turn at a time.** A second message for the same
 *    sender while busy gets a short notice. Different senders do not share the
 *    gate and may run concurrently.
 *  - **Every accepted message ends in either a reply or an audited reason.**
 *  - **Blank senderId never becomes an accepted message** — providers return
 *    null at normalize time.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ImConnectionStatus, ImRobot, ImTurnOutcome } from '@ccc/shared/protocol'
import { ROBOT_DEFAULT_MAX_TURN_MS } from '@ccc/shared/protocol'
import { c3HomeDir } from '../../kernel/config/paths.js'
import type { RobotTurnResult, RunRobotTurnInput } from '../../wiring/robot-turn.js'
import { formatContextSeed } from './context-seed.js'
import { screenInbound } from './inbound-guard.js'
import { screenOutbound } from './outbound-guard.js'
import { resolveImProvider } from './registry.js'
import {
  beginTurn,
  claimInboundMessage,
  commitContextTurn,
  failContextTurn,
  finishTurn,
  getConversation,
  getRobot,
  isStoreAvailable,
  listEnabledRobots,
  loadCommittedContext,
  resolvedSessionRef,
  robotSecret,
  RobotStoreError,
} from './robot-store.js'
import { conversationGateKey, conversationIdentityOf, threadKeyFor } from './thread-key.js'
import type { ImConnection, ImInboundMessage, ImProviderCapabilities } from './types.js'

export interface ImSupervisorDeps {
  runTurn: (input: RunRobotTurnInput) => Promise<RobotTurnResult>
}

interface RobotHandle {
  connection: ImConnection
  capabilities: ImProviderCapabilities
  lastError?: string
}

let deps: ImSupervisorDeps | null = null
let handles: Map<string, RobotHandle> | null = null
/** Turns currently running, keyed by Conversation identity. */
const inFlight = new Map<string, Promise<void>>()
const failures = new Map<string, string>()

export function robotWorkdir(name: string): string {
  return join(c3HomeDir(), 'robots', name)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function accepts(robot: ImRobot, msg: ImInboundMessage): boolean {
  if (msg.chatType === 'group') {
    if (robot.requireMention && !msg.mentionedBot) return false
    if (robot.chatAllowlist.length > 0 && !robot.chatAllowlist.includes(msg.chatId)) return false
    return true
  }
  if (robot.dmMode === 'disabled') return false
  if (robot.dmMode === 'allowlist') return robot.dmAllowlist.includes(msg.senderId)
  return true
}

function failureNotice(outcome: ImTurnOutcome): string {
  switch (outcome) {
    case 'timeout':
      return '这个问题处理超时了,已经中止。'
    case 'blocked':
      return '这一步需要人工授权,我在群里无法完成。请到 c3 中继续。'
    case 'guard_refused':
      return '回答里包含疑似凭据的内容,已拦下未发送。请到 c3 会话中查看。'
    case 'input_rejected':
      return '这条消息未处理也未保存。'
    default:
      return '处理时出错了,请到 c3 会话中查看详情。'
  }
}

async function deliver(
  handle: RobotHandle,
  chatId: string,
  text: string,
  replyTo: string,
): Promise<string> {
  const { messageId } = await handle.connection.send(chatId, { text, replyTo })
  return messageId
}

async function runOneTurn(
  robot: ImRobot,
  handle: RobotHandle,
  msg: ImInboundMessage,
  threadKey: string,
  contextTurnId: string,
): Promise<void> {
  const runner = deps?.runTurn
  if (!runner) {
    failContextTurn(contextTurnId)
    return
  }

  const identity = conversationIdentityOf(robot.platform, robot.id, threadKey, msg.senderId)
  const turnId = beginTurn({
    robotId: robot.id,
    threadKey,
    chatId: msg.chatId,
    senderId: msg.senderId,
    messageId: msg.messageId,
  })

  const inbound = screenInbound(msg.text)
  if (!inbound.ok) {
    failContextTurn(contextTurnId)
    finishTurn(turnId, {
      outcome: 'input_rejected',
      rejectReason: inbound.reason,
      outboundChars: 0,
    })
    await deliver(handle, msg.chatId, inbound.notice, msg.messageId).catch(() => {})
    return
  }

  const workdir = robotWorkdir(robot.name)
  try {
    mkdirSync(workdir, { recursive: true })
  } catch (err) {
    failContextTurn(contextTurnId)
    finishTurn(turnId, { outcome: 'error', error: `workdir: ${errText(err)}` })
    await deliver(handle, msg.chatId, failureNotice('error'), msg.messageId).catch(() => {})
    return
  }

  const conversation = getConversation(identity)
  const sessionRef = conversation ? resolvedSessionRef(conversation, robot.vendor) : null
  const seed = sessionRef ? [] : loadCommittedContext(identity)
  const prompt = sessionRef ? msg.text : formatContextSeed(seed, msg.text)

  const result = await runner({
    robotId: robot.id,
    workspacePath: workdir,
    ...(sessionRef ? { sessionId: sessionRef.sessionId } : {}),
    prompt,
    maxTurnMs: robot.maxTurnMs ?? ROBOT_DEFAULT_MAX_TURN_MS,
    signal: new AbortController().signal,
  })

  if (result.outcome !== 'complete' || !result.lastMessage.trim()) {
    const outcome = result.outcome === 'complete' ? 'error' : result.outcome
    failContextTurn(contextTurnId)
    finishTurn(turnId, {
      outcome,
      sessionId: result.sessionId,
      error: result.detail ?? null,
    })
    await deliver(handle, msg.chatId, failureNotice(outcome), msg.messageId).catch((err) =>
      console.error('[c3][im] failure notice not delivered:', errText(err)),
    )
    return
  }

  const screened = screenOutbound(result.lastMessage, handle.capabilities.maxOutboundChars)
  if (!screened.ok) {
    failContextTurn(contextTurnId)
    finishTurn(turnId, { outcome: 'guard_refused', sessionId: result.sessionId })
    await deliver(handle, msg.chatId, failureNotice('guard_refused'), msg.messageId).catch(() => {})
    return
  }

  try {
    const outMessageId = await deliver(handle, msg.chatId, screened.text, msg.messageId)
    commitContextTurn({
      contextTurnId,
      userText: msg.text,
      assistantText: screened.text,
      sessionId: result.sessionId,
      vendor: robot.vendor,
    })
    finishTurn(turnId, {
      outcome: 'complete',
      sessionId: result.sessionId,
      outboundChars: screened.text.length,
      outMessageId,
    })
  } catch (err) {
    failContextTurn(contextTurnId)
    finishTurn(turnId, {
      outcome: 'error',
      sessionId: result.sessionId,
      error: `send: ${errText(err)}`,
    })
  }
}

function onInbound(robotId: string, msg: ImInboundMessage): void {
  const handle = handles?.get(robotId)
  if (!handle) return
  const robot = getRobot(robotId)
  if (!robot || !robot.enabled) return
  if (!accepts(robot, msg)) return
  // Provider normalize must already drop blank senderId; belt-and-braces here.
  if (!msg.senderId.trim()) return

  if (!isStoreAvailable()) {
    void handle.connection
      .send(msg.chatId, {
        text: '机器人存储不可用,本回合未启动。',
        replyTo: msg.messageId,
      })
      .catch(() => {})
    return
  }

  const threadKey = threadKeyFor(msg)
  const identity = conversationIdentityOf(robot.platform, robot.id, threadKey, msg.senderId)
  const gate = conversationGateKey(identity)

  if (inFlight.has(gate)) {
    void handle.connection
      .send(msg.chatId, { text: '上一个问题还在处理,稍后再问我。', replyTo: msg.messageId })
      .catch(() => {})
    return
  }

  // Occupy the gate synchronously before claim so a concurrent sender-identical
  // message cannot fail this turn's pending row as an "orphan".
  let releaseHold: () => void = () => {}
  inFlight.set(
    gate,
    new Promise<void>((r) => {
      releaseHold = r
    }),
  )

  let claimed: ReturnType<typeof claimInboundMessage>
  try {
    claimed = claimInboundMessage({
      platform: robot.platform,
      robotId: robot.id,
      threadKey,
      senderId: msg.senderId,
      chatId: msg.chatId,
      vendor: robot.vendor,
      messageId: msg.messageId,
    })
  } catch (err) {
    inFlight.delete(gate)
    releaseHold()
    const text =
      err instanceof RobotStoreError && err.code === 'db_unavailable'
        ? '机器人存储不可用,本回合未启动。'
        : failureNotice('error')
    void handle.connection.send(msg.chatId, { text, replyTo: msg.messageId }).catch(() => {})
    return
  }

  if (claimed.kind === 'duplicate') {
    inFlight.delete(gate)
    releaseHold()
    return
  }

  const running = runOneTurn(robot, handle, msg, threadKey, claimed.contextTurnId)
    .catch((err) => {
      console.error('[c3][im] turn failed:', errText(err))
      try {
        failContextTurn(claimed.contextTurnId)
      } catch {
        /* noop */
      }
    })
    .finally(() => {
      inFlight.delete(gate)
      releaseHold()
    })
  inFlight.set(gate, running)
}

async function connectRobot(robot: ImRobot): Promise<void> {
  const provider = resolveImProvider(robot.platform)
  if (!provider) {
    failures.set(robot.id, `platform ${robot.platform} is not supported by this build`)
    return
  }
  try {
    const connection = await provider.connect({
      robotId: robot.id,
      appId: robot.appId,
      appSecret: robotSecret(robot.id),
      onMessage: (m) => onInbound(robot.id, m),
    })
    handles?.set(robot.id, { connection, capabilities: provider.capabilities })
    failures.delete(robot.id)
  } catch (err) {
    failures.set(robot.id, errText(err))
    console.error(`[c3][im] robot ${robot.name} failed to connect:`, errText(err))
  }
}

export function startImSupervisor(input: ImSupervisorDeps): void {
  if (handles) return
  if (!isStoreAvailable()) {
    console.warn('[c3][im] robot store unavailable; supervisor not started')
    return
  }
  deps = input
  handles = new Map()
  for (const robot of listEnabledRobots()) void connectRobot(robot)
}

export async function reloadRobot(robotId: string): Promise<void> {
  if (!handles) return
  const handle = handles.get(robotId)
  if (handle) {
    handles.delete(robotId)
    await handle.connection.close().catch(() => {})
  }
  failures.delete(robotId)
  const robot = getRobot(robotId)
  if (robot?.enabled) await connectRobot(robot)
}

export async function stopImSupervisor(timeoutMs = 30_000): Promise<void> {
  const open = handles
  handles = null
  deps = null
  if (open) {
    await Promise.allSettled([...open.values()].map((h) => h.connection.close()))
    open.clear()
  }
  if (inFlight.size === 0) return
  const drained = Promise.allSettled([...inFlight.values()])
  const timer = new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.())
  await Promise.race([drained, timer])
  inFlight.clear()
}

export function robotConnectionStatus(robotId: string): ImConnectionStatus | undefined {
  const failure = failures.get(robotId)
  if (failure) return { state: 'failed', reconnectAttempts: 0, lastError: failure }
  return handles?.get(robotId)?.connection.status()
}
