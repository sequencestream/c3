import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ImConnectionStatus, ImRobot, ImTurnOutcome } from '@ccc/shared/protocol'
import { ROBOT_DEFAULT_MAX_TURN_MS } from '@ccc/shared/protocol'
import { c3HomeDir } from '../../kernel/config/paths.js'
import type { RobotTurnResult, RunRobotTurnInput } from '../../wiring/robot-turn.js'
import { redactSecrets } from '../pr-events/tool-defs.js'
import { formatContextSeed } from './context-seed.js'
import { screenInbound } from './inbound-guard.js'
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
import type { ImInboundMessage, ImProviderCapabilities } from './types.js'

export interface ImSupervisorDeps {
  runTurn: (input: RunRobotTurnInput) => Promise<RobotTurnResult>
}
interface RobotHandle {
  status: () => ImConnectionStatus
  close: () => Promise<void>
  sendOutbound: (
    content: OutboundContent,
    target: OutboundTarget,
  ) => Promise<Awaited<ReturnType<typeof sendGuarded>>>
}
let deps: ImSupervisorDeps | null = null
let handles: Map<string, RobotHandle> | null = null
const inFlight = new Map<string, Promise<void>>()
const failures = new Map<string, string>()
export function robotWorkdir(name: string): string {
  return join(c3HomeDir(), 'robots', name)
}
function errText(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200)
}
function targetOf(m: ImInboundMessage): OutboundTarget {
  return { chatId: m.chatId, chatType: m.chatType, senderId: m.senderId, replyTo: m.messageId }
}
function accepts(r: ImRobot, m: ImInboundMessage): boolean {
  if (m.chatType === 'group')
    return (
      (!r.requireMention || m.mentionedBot) &&
      (!r.chatAllowlist.length || r.chatAllowlist.includes(m.chatId))
    )
  return r.dmMode === 'open' || (r.dmMode === 'allowlist' && r.dmAllowlist.includes(m.senderId))
}
function notice(o: ImTurnOutcome): FixedNoticeId {
  return o === 'timeout'
    ? 'timeout'
    : o === 'blocked'
      ? 'blocked'
      : o === 'guard_refused'
        ? 'guard_refused'
        : o === 'busy'
          ? 'busy'
          : 'error'
}
function fail(id: string): void {
  try {
    failContextTurn(id)
  } catch (e) {
    console.error('[c3][im] context failure:', errText(e))
  }
}
async function fixed(h: RobotHandle, n: FixedNoticeId, t: OutboundTarget) {
  return h.sendOutbound({ category: 'fixed_notice', notice: n }, t)
}

async function runOneTurn(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
  threadKey: string,
  contextTurnId: string,
): Promise<void> {
  const turnId = beginTurn({
    robotId: r.id,
    threadKey,
    chatId: m.chatId,
    senderId: m.senderId,
    messageId: m.messageId,
  })
  const target = targetOf(m),
    inbound = screenInbound(m.text)
  if (!inbound.ok) {
    fail(contextTurnId)
    const s = await fixed(
      h,
      inbound.reason === 'credential' ? 'input_rejected_credential' : 'input_rejected_too_long',
      target,
    )
    finishTurn(turnId, {
      outcome: 'input_rejected',
      rejectReason: inbound.reason,
      outboundChars: s.ok ? s.outboundChars : 0,
      outMessageId: s.ok ? s.messageId : null,
      error: s.ok ? null : s.reason,
    })
    return
  }
  const runner = deps?.runTurn
  if (!runner) {
    fail(contextTurnId)
    const s = await fixed(h, 'error', target)
    finishTurn(turnId, {
      outcome: 'error',
      error: 'runner unavailable',
      outboundChars: s.ok ? s.outboundChars : 0,
    })
    return
  }
  try {
    mkdirSync(robotWorkdir(r.name), { recursive: true })
  } catch (e) {
    fail(contextTurnId)
    const s = await fixed(h, 'error', target)
    finishTurn(turnId, {
      outcome: 'error',
      error: `workdir: ${errText(e)}`,
      outboundChars: s.ok ? s.outboundChars : 0,
    })
    return
  }
  const identity = conversationIdentityOf(r.platform, r.id, threadKey, m.senderId)
  const c = getConversation(identity),
    ref = c ? resolvedSessionRef(c, r.vendor) : null
  let result: RobotTurnResult
  try {
    result = await runner({
      robotId: r.id,
      workspacePath: robotWorkdir(r.name),
      ...(ref ? { sessionId: ref.sessionId } : {}),
      prompt: ref ? m.text : formatContextSeed(loadCommittedContext(identity), m.text),
      maxTurnMs: r.maxTurnMs ?? ROBOT_DEFAULT_MAX_TURN_MS,
      signal: new AbortController().signal,
    })
  } catch (e) {
    fail(contextTurnId)
    const s = await fixed(h, 'error', target)
    finishTurn(turnId, {
      outcome: 'error',
      error: `run: ${errText(e)}`,
      outboundChars: s.ok ? s.outboundChars : 0,
    })
    return
  }
  if (result.outcome !== 'complete' || !result.lastMessage.trim()) {
    const o: ImTurnOutcome = result.outcome === 'complete' ? 'error' : result.outcome
    fail(contextTurnId)
    const s = await fixed(h, notice(o), target)
    finishTurn(turnId, {
      outcome: o,
      sessionId: result.sessionId,
      error: result.detail ? errText(result.detail) : s.ok ? null : s.reason,
      outboundChars: s.ok ? s.outboundChars : 0,
      outMessageId: s.ok ? s.messageId : null,
    })
    return
  }
  const s = await h.sendOutbound({ category: 'final_answer', text: result.lastMessage }, target)
  if (s.ok) {
    commitContextTurn({
      contextTurnId,
      userText: m.text,
      assistantText: s.text,
      sessionId: result.sessionId,
      vendor: r.vendor,
    })
    finishTurn(turnId, {
      outcome: 'complete',
      sessionId: result.sessionId,
      outboundChars: s.outboundChars,
      outMessageId: s.messageId,
    })
    return
  }
  fail(contextTurnId)
  finishTurn(turnId, {
    outcome: s.reason === 'send_failed' ? 'error' : 'guard_refused',
    sessionId: result.sessionId,
    outboundChars: s.outboundChars ?? 0,
    outMessageId: s.messageId ?? null,
    error: s.reason === 'send_failed' ? `send: ${errText(s.error ?? 'failed')}` : s.reason,
  })
}

function onInbound(id: string, m: ImInboundMessage): void {
  const h = handles?.get(id),
    r = getRobot(id)
  if (!h || !r || !r.enabled || !m.senderId.trim() || !accepts(r, m)) return
  const target = targetOf(m)
  if (!isStoreAvailable()) {
    void fixed(h, 'store_unavailable', target)
    return
  }
  const threadKey = threadKeyFor(m),
    gate = conversationGateKey(conversationIdentityOf(r.platform, r.id, threadKey, m.senderId))
  if (inFlight.has(gate)) {
    const tid = beginTurn({
      robotId: r.id,
      threadKey,
      chatId: m.chatId,
      senderId: m.senderId,
      messageId: m.messageId,
    })
    void fixed(h, 'busy', target)
      .then((s) =>
        finishTurn(tid, {
          outcome: 'busy',
          outboundChars: s.ok ? s.outboundChars : 0,
          outMessageId: s.ok ? s.messageId : null,
          error: s.ok ? null : s.reason,
        }),
      )
      .catch((e) => finishTurn(tid, { outcome: 'busy', error: errText(e) }))
    return
  }
  let release = () => {}
  inFlight.set(
    gate,
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  let claim: ReturnType<typeof claimInboundMessage>
  try {
    claim = claimInboundMessage({
      platform: r.platform,
      robotId: r.id,
      threadKey,
      senderId: m.senderId,
      chatId: m.chatId,
      vendor: r.vendor,
      messageId: m.messageId,
    })
  } catch (e) {
    inFlight.delete(gate)
    release()
    void fixed(
      h,
      e instanceof RobotStoreError && e.code === 'db_unavailable' ? 'store_unavailable' : 'error',
      target,
    )
    return
  }
  if (claim.kind === 'duplicate') {
    inFlight.delete(gate)
    release()
    return
  }
  const running = runOneTurn(r, h, m, threadKey, claim.contextTurnId)
    .catch((e) => {
      console.error('[c3][im] turn failed:', errText(e))
      fail(claim.contextTurnId)
    })
    .finally(() => {
      inFlight.delete(gate)
      release()
    })
  inFlight.set(gate, running)
}

function wrapHandle(
  robotId: string,
  c: { status: () => ImConnectionStatus; send: RawImSend; close: () => Promise<void> },
  capabilities: ImProviderCapabilities,
): RobotHandle {
  return {
    status: c.status,
    close: c.close,
    sendOutbound: (content, target) =>
      sendGuarded({
        robotId,
        target,
        content,
        maxOutboundChars: capabilities.maxOutboundChars,
        rawSend: c.send,
      }),
  }
}
async function connectRobot(r: ImRobot): Promise<void> {
  const p = resolveImProvider(r.platform)
  if (!p) {
    failures.set(r.id, `platform ${r.platform} is not supported by this build`)
    return
  }
  try {
    const c = await p.connect({
      robotId: r.id,
      appId: r.appId,
      appSecret: robotSecret(r.id),
      onMessage: (m) => onInbound(r.id, m),
    })
    handles?.set(r.id, wrapHandle(r.id, c, p.capabilities))
    failures.delete(r.id)
  } catch (e) {
    failures.set(r.id, errText(e))
    console.error(`[c3][im] robot ${r.name} failed to connect:`, errText(e))
  }
}
export function startImSupervisor(input: ImSupervisorDeps): void {
  if (handles || !isStoreAvailable()) return
  deps = input
  handles = new Map()
  for (const r of listEnabledRobots()) void connectRobot(r)
}
export async function reloadRobot(id: string): Promise<void> {
  if (!handles) return
  const h = handles.get(id)
  if (h) {
    handles.delete(id)
    await h.close().catch(() => {})
  }
  failures.delete(id)
  const r = getRobot(id)
  if (r?.enabled) await connectRobot(r)
}
export async function stopImSupervisor(timeoutMs = 30_000): Promise<void> {
  const open = handles
  handles = null
  deps = null
  if (open) {
    await Promise.allSettled([...open.values()].map((h) => h.close()))
    open.clear()
  }
  if (!inFlight.size) return
  await Promise.race([
    Promise.allSettled([...inFlight.values()]),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
  ])
  inFlight.clear()
}
export function robotConnectionStatus(id: string): ImConnectionStatus | undefined {
  const f = failures.get(id)
  return f ? { state: 'failed', reconnectAttempts: 0, lastError: f } : handles?.get(id)?.status()
}
