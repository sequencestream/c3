/**
 * The IM supervisor: holds one connection per enabled robot and turns an inbound
 * chat message into one agent turn and one reply.
 *
 * Everything platform-neutral lives here rather than in a provider, so a second
 * platform inherits it: the response policy (@-mention required, chat and DM
 * allowlists), repeat-delivery suppression, one-turn-at-a-time per thread, and
 * the audit row. Every outbound byte goes through {@link sendGuarded} — this
 * module never calls provider `send` directly.
 *
 * Two properties are worth stating outright:
 *
 *  - **One thread runs one turn at a time.** A second message arriving while a
 *    thread is busy is answered with a short notice instead of starting a
 *    parallel run that would race the first for the same session. Different
 *    threads are unbounded, matching c3's stance elsewhere.
 *  - **Every accepted message ends in either a reply or an audited reason.** A
 *    robot that silently drops a question is worse than one that says it failed,
 *    because the person in the chat cannot tell the difference from being ignored.
 *
 * Lifecycle follows the scheduler's shape (`features/schedules`): a module-level
 * handle, an idempotent start, and a stop that stops accepting work before
 * draining what is in flight.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ImConnectionStatus, ImRobot, ImTurnOutcome } from '@ccc/shared/protocol'
import { ROBOT_DEFAULT_MAX_TURN_MS } from '@ccc/shared/protocol'
import { c3HomeDir } from '../../kernel/config/paths.js'
import type { RobotTurnResult, RunRobotTurnInput } from '../../wiring/robot-turn.js'
import { redactSecrets } from '../pr-events/tool-defs.js'
import {
  sendGuarded,
  type FixedNoticeId,
  type OutboundContent,
  type OutboundTarget,
  type RawImSend,
} from './outbound-guard.js'
import { resolveImProvider } from './registry.js'
import {
  beginTurn,
  bindThreadSession,
  finishTurn,
  getRobot,
  listEnabledRobots,
  openThread,
  robotSecret,
} from './robot-store.js'
import { threadKeyFor } from './thread-key.js'
import type { ImInboundMessage, ImProviderCapabilities } from './types.js'

export interface ImSupervisorDeps {
  runTurn: (input: RunRobotTurnInput) => Promise<RobotTurnResult>
}

/**
 * Live link for one robot. The raw provider sender is closed over inside
 * `sendOutbound` and is not exposed — callers cannot bypass the guard.
 */
interface RobotHandle {
  capabilities: ImProviderCapabilities
  status: () => ImConnectionStatus
  close: () => Promise<void>
  sendOutbound: (
    content: OutboundContent,
    target: OutboundTarget,
  ) => Promise<Awaited<ReturnType<typeof sendGuarded>>>
  /** Set when the link could not be established; surfaced instead of a status. */
  lastError?: string
}

let deps: ImSupervisorDeps | null = null
let handles: Map<string, RobotHandle> | null = null
/** Turns currently running, keyed by robot+thread. The serialization gate. */
const inFlight = new Map<string, Promise<void>>()
/** Connection failures for robots that never got a handle. */
const failures = new Map<string, string>()

/** A robot's working directory. Follows `--db`, so one override moves everything. */
export function robotWorkdir(name: string): string {
  return join(c3HomeDir(), 'robots', name)
}

/** Diagnostic text for audit / logs: redact secrets before any persistence. */
function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactSecrets(raw).slice(0, 200)
}

function targetOf(msg: ImInboundMessage): OutboundTarget {
  return {
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
    replyTo: msg.messageId,
  }
}

/**
 * Whether this robot should answer this message at all. The narrow defaults live
 * in the store; this only applies them. Outbound re-checks allowlists at send
 * time — this is the inbound accept gate only.
 */
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

/** Map a non-complete turn outcome onto a registered fixed notice. */
function noticeForOutcome(outcome: ImTurnOutcome): FixedNoticeId {
  switch (outcome) {
    case 'timeout':
      return 'timeout'
    case 'blocked':
      return 'blocked'
    case 'guard_refused':
      return 'guard_refused'
    case 'busy':
      return 'busy'
    default:
      return 'error'
  }
}

/** Run one turn for one accepted message, and make sure something comes back. */
async function runOneTurn(
  robot: ImRobot,
  handle: RobotHandle,
  msg: ImInboundMessage,
  threadKey: string,
): Promise<void> {
  const runner = deps?.runTurn
  if (!runner) return

  const thread = openThread({
    robotId: robot.id,
    threadKey,
    chatId: msg.chatId,
    vendor: robot.vendor,
    messageId: msg.messageId,
  })
  const turnId = beginTurn({
    robotId: robot.id,
    threadKey,
    chatId: msg.chatId,
    senderId: msg.senderId,
    messageId: msg.messageId,
  })
  const target = targetOf(msg)

  const workdir = robotWorkdir(robot.name)
  try {
    mkdirSync(workdir, { recursive: true })
  } catch (err) {
    const sent = await handle.sendOutbound({ category: 'fixed_notice', notice: 'error' }, target)
    finishTurn(turnId, {
      outcome: 'error',
      error: `workdir: ${errText(err)}`,
      outboundChars: sent.ok ? sent.outboundChars : 0,
      outMessageId: sent.ok ? sent.messageId : null,
    })
    return
  }

  const result = await runner({
    robotId: robot.id,
    workspacePath: workdir,
    ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
    prompt: msg.text,
    maxTurnMs: robot.maxTurnMs ?? ROBOT_DEFAULT_MAX_TURN_MS,
    signal: new AbortController().signal,
  })

  // Bind before replying: the session exists regardless of whether the answer
  // reaches the chat, and the next message in this thread must resume it.
  if (result.sessionId) {
    bindThreadSession(robot.id, threadKey, result.sessionId, robot.vendor)
  }

  if (result.outcome !== 'complete' || !result.lastMessage.trim()) {
    const outcome: ImTurnOutcome = result.outcome === 'complete' ? 'error' : result.outcome
    const sent = await handle.sendOutbound(
      { category: 'fixed_notice', notice: noticeForOutcome(outcome) },
      target,
    )
    finishTurn(turnId, {
      outcome,
      sessionId: result.sessionId,
      error: result.detail ? errText(result.detail) : null,
      outboundChars: sent.ok ? sent.outboundChars : 0,
      outMessageId: sent.ok ? sent.messageId : null,
    })
    return
  }

  const sent = await handle.sendOutbound(
    { category: 'final_answer', text: result.lastMessage },
    target,
  )

  if (sent.ok) {
    finishTurn(turnId, {
      outcome: 'complete',
      sessionId: result.sessionId,
      outboundChars: sent.outboundChars,
      outMessageId: sent.messageId,
    })
    return
  }

  if (sent.reason === 'credential') {
    finishTurn(turnId, {
      outcome: 'guard_refused',
      sessionId: result.sessionId,
      outboundChars: sent.outboundChars ?? 0,
      outMessageId: sent.messageId ?? null,
    })
    return
  }

  if (sent.reason === 'send_failed') {
    finishTurn(turnId, {
      outcome: 'error',
      sessionId: result.sessionId,
      outboundChars: 0,
      error: `send: ${errText(sent.error ?? 'failed')}`,
    })
    return
  }

  finishTurn(turnId, {
    outcome: 'guard_refused',
    sessionId: result.sessionId,
    outboundChars: 0,
    error: sent.reason,
  })
}

function onInbound(robotId: string, msg: ImInboundMessage): void {
  const handle = handles?.get(robotId)
  if (!handle) return
  // Re-read the robot every message: an operator may have narrowed its policy or
  // disabled it since the connection opened.
  const robot = getRobot(robotId)
  if (!robot || !robot.enabled) return
  if (!accepts(robot, msg)) return

  const threadKey = threadKeyFor(msg)

  // Repeat delivery (a reconnect can redeliver): the same message on the same
  // thread must not be answered twice.
  const thread = openThread({
    robotId: robot.id,
    threadKey,
    chatId: msg.chatId,
    vendor: robot.vendor,
    messageId: msg.messageId,
  })
  if (thread.lastMessageId === msg.messageId && thread.turnCount > 0) return

  const gate = `${robot.id}::${threadKey}`
  if (inFlight.has(gate)) {
    const turnId = beginTurn({
      robotId: robot.id,
      threadKey,
      chatId: msg.chatId,
      senderId: msg.senderId,
      messageId: msg.messageId,
    })
    void handle
      .sendOutbound({ category: 'fixed_notice', notice: 'busy' }, targetOf(msg))
      .then((sent) => {
        finishTurn(turnId, {
          outcome: 'busy',
          outboundChars: sent.ok ? sent.outboundChars : 0,
          outMessageId: sent.ok ? sent.messageId : null,
          error: sent.ok ? null : sent.reason,
        })
      })
      .catch((err) => {
        finishTurn(turnId, { outcome: 'busy', outboundChars: 0, error: errText(err) })
      })
    return
  }

  const running = runOneTurn(robot, handle, msg, threadKey)
    .catch((err) => console.error('[c3][im] turn failed:', errText(err)))
    .finally(() => inFlight.delete(gate))
  inFlight.set(gate, running)
}

function wrapHandle(
  robotId: string,
  connection: { status: () => ImConnectionStatus; send: RawImSend; close: () => Promise<void> },
  capabilities: ImProviderCapabilities,
): RobotHandle {
  // Bind raw send into the guard closure without exposing it on the handle.
  const { send: rawSend, status, close } = connection
  return {
    capabilities,
    status,
    close,
    sendOutbound: (content, target) =>
      sendGuarded({
        robotId,
        target,
        content,
        maxOutboundChars: capabilities.maxOutboundChars,
        rawSend,
      }),
  }
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
    handles?.set(robot.id, wrapHandle(robot.id, connection, provider.capabilities))
    failures.delete(robot.id)
  } catch (err) {
    // A robot that cannot connect is a visible, recoverable state, never a
    // reason to stop the other robots or the server.
    failures.set(robot.id, errText(err))
    console.error(`[c3][im] robot ${robot.name} failed to connect:`, errText(err))
  }
}

/** Start connections for every enabled robot. Idempotent. */
export function startImSupervisor(input: ImSupervisorDeps): void {
  if (handles) return
  deps = input
  handles = new Map()
  for (const robot of listEnabledRobots()) void connectRobot(robot)
}

/**
 * Re-apply a robot's configuration: drop its connection and, if it is still
 * enabled, dial again with the current credentials.
 */
export async function reloadRobot(robotId: string): Promise<void> {
  if (!handles) return
  const handle = handles.get(robotId)
  if (handle) {
    handles.delete(robotId)
    await handle.close().catch(() => {})
  }
  failures.delete(robotId)
  const robot = getRobot(robotId)
  if (robot?.enabled) await connectRobot(robot)
}

/**
 * Stop accepting inbound work, then drain what is already running.
 *
 * Closing first matters: a connection left open during the drain would keep
 * feeding new messages into a supervisor that is shutting down. This runs on
 * SIGINT/SIGTERM and on a self-update relaunch, so a link left open here would
 * survive into the next process.
 */
export async function stopImSupervisor(timeoutMs = 30_000): Promise<void> {
  const open = handles
  handles = null
  deps = null
  if (open) {
    await Promise.allSettled([...open.values()].map((h) => h.close()))
    open.clear()
  }
  if (inFlight.size === 0) return
  const drained = Promise.allSettled([...inFlight.values()])
  const timer = new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.())
  await Promise.race([drained, timer])
  inFlight.clear()
}

/** A robot's live link state, for the console. */
export function robotConnectionStatus(robotId: string): ImConnectionStatus | undefined {
  const failure = failures.get(robotId)
  if (failure) return { state: 'failed', reconnectAttempts: 0, lastError: failure }
  return handles?.get(robotId)?.status()
}
