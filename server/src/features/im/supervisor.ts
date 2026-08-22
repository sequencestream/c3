import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ImConnectionStatus, ImRobot, ImTurnOutcome } from '@ccc/shared/protocol'
import { ROBOT_DEFAULT_MAX_TURN_MS } from '@ccc/shared/protocol'
import { c3HomeDir } from '../../kernel/config/paths.js'
import type { RobotTurnResult, RunRobotTurnInput } from '../../wiring/robot-turn.js'
import { redactSecrets } from '../pr-events/tool-defs.js'
import {
  accountNamespaceOf,
  consumeChallenge,
  getActiveBindingForSender,
  isIdentityStoreAvailable,
  providerAccountKeyOf,
} from './identity-store.js'
import { chatContextFor, resolveCallScope } from './call-scope.js'
import { formatContextSeed } from './context-seed.js'
import { screenInbound } from './inbound-guard.js'
import {
  sendGuarded,
  type OutboundContent,
  type OutboundTarget,
  type RawImSend,
  type RobotMessageRef,
  type RobotRenderContext,
} from './outbound-guard.js'
import {
  createTurnDisplaySignals,
  outcomeToRuntimeMessage,
  pickSecurityMessage,
  resolveRobotRenderContext,
  runtimeInputTooLongRef,
} from './robot-message-registry.js'
import { resolveImProvider } from './registry.js'
import { registerRobotHandleLookup } from './supervisor-access.js'
import {
  beginTurn,
  claimGateMessage,
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
import { handleTodoControl } from './l2-control.js'
import { parseTodoInbound } from './todo-token-parse.js'
import type { ImInboundMessage, ImProviderCapabilities } from './types.js'

export interface ImSupervisorDeps {
  runTurn: (input: RunRobotTurnInput) => Promise<RobotTurnResult>
  broadcastIntents?: (workspacePath: string) => void
}
interface RobotHandle {
  status: () => ImConnectionStatus
  close: () => Promise<void>
  maxOutboundChars: number
  rawSend: RawImSend
  sendOutbound: (
    content: OutboundContent,
    target: OutboundTarget,
    renderContext: RobotRenderContext,
  ) => Promise<Awaited<ReturnType<typeof sendGuarded>>>
}
let deps: ImSupervisorDeps | null = null
let handles: Map<string, RobotHandle> | null = null
const inFlight = new Map<string, Promise<void>>()
const failures = new Map<string, string>()

/** Base64url-ish token shape (128-bit ≈ 22 chars; allow a small range). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,48}$/

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
function renderCtx(r: ImRobot, subject?: string | null): RobotRenderContext {
  return resolveRobotRenderContext({ subject, robotLocale: r.locale })
}
function fail(id: string): void {
  try {
    failContextTurn(id)
  } catch (e) {
    console.error('[c3][im] context failure:', errText(e))
  }
}
async function fixed(
  h: RobotHandle,
  message: RobotMessageRef,
  t: OutboundTarget,
  ctx: RobotRenderContext,
) {
  return h.sendOutbound({ category: 'fixed_notice', message }, t, ctx)
}
async function bindingNotice(
  h: RobotHandle,
  message: RobotMessageRef,
  t: OutboundTarget,
  ctx: RobotRenderContext,
) {
  return h.sendOutbound({ category: 'binding_notice', message, origin: t }, t, ctx)
}

function identityRequiredRef(chatType: 'group' | 'p2p'): RobotMessageRef {
  if (chatType === 'group') {
    return {
      key: 'binding.identityRequiredGroup',
      params: { nav: { kind: 'webEntry' } },
    }
  }
  return {
    key: 'binding.identityRequired',
    params: { nav: { kind: 'webEntry' } },
  }
}

async function claimControlMessage(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
): Promise<'duplicate' | 'claimed' | 'error'> {
  const ctx = renderCtx(r)
  try {
    return claimGateMessage({
      platform: r.platform,
      robotId: r.id,
      threadKey: threadKeyFor(m),
      senderId: m.senderId,
      messageId: m.messageId,
    })
  } catch (e) {
    void fixed(
      h,
      e instanceof RobotStoreError && e.code === 'db_unavailable'
        ? { key: 'runtime.storeUnavailable', params: {} }
        : { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
      targetOf(m),
      ctx,
    )
    return 'error'
  }
}

async function auditedBindingNotice(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
  message: RobotMessageRef,
  outcome: ImTurnOutcome,
): Promise<void> {
  const tid = beginTurn({
    robotId: r.id,
    threadKey: threadKeyFor(m),
    chatId: m.chatId,
    senderId: m.senderId,
    messageId: m.messageId,
  })
  const s = await bindingNotice(h, message, targetOf(m), renderCtx(r))
  finishTurn(tid, {
    outcome,
    outboundChars: s.ok ? s.outboundChars : 0,
    outMessageId: s.ok ? s.messageId : null,
    error: s.ok ? null : s.reason,
  })
}

/**
 * Deterministic bind-control path before ordinary chat. Returns true when the
 * message was fully handled here (no agent run). Claims the inbound messageId
 * first so a redelivery cannot consume twice or send a second notice.
 */
async function handleBindingControl(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
): Promise<boolean> {
  const text = m.text.trim()
  if (!TOKEN_SHAPE.test(text)) return false

  const gate = await claimControlMessage(r, h, m)
  if (gate !== 'claimed') return true

  if (m.chatType === 'group') {
    await auditedBindingNotice(r, h, m, { key: 'binding.useDm', params: {} }, 'identity_required')
    return true
  }

  const ns = accountNamespaceOf(r.platform, r.appId)
  const result = consumeChallenge({
    robotId: r.id,
    accountNamespace: ns,
    senderId: m.senderId,
    token: text,
  })
  await auditedBindingNotice(
    r,
    h,
    m,
    result.ok
      ? { key: 'binding.success', params: {} }
      : { key: 'binding.tokenUnusable', params: {} },
    result.ok ? 'complete' : 'identity_required',
  )
  return true
}

async function runOneTurn(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
  threadKey: string,
  contextTurnId: string,
  identity: ReturnType<typeof conversationIdentityOf>,
  turnScopeHash: string,
): Promise<void> {
  const ctx = renderCtx(r, identity.subject)
  const turnId = beginTurn({
    robotId: r.id,
    threadKey,
    chatId: m.chatId,
    senderId: m.senderId,
    messageId: m.messageId,
  })
  const target = targetOf(m)
  const inbound = screenInbound(m.text)
  if (!inbound.ok) {
    fail(contextTurnId)
    const msg: RobotMessageRef =
      inbound.reason === 'credential'
        ? { key: 'runtime.inputRejectedCredential', params: {} }
        : runtimeInputTooLongRef()
    const s = await fixed(h, msg, target, ctx)
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
    const s = await fixed(
      h,
      { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
      target,
      ctx,
    )
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
    const s = await fixed(
      h,
      { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
      target,
      ctx,
    )
    finishTurn(turnId, {
      outcome: 'error',
      error: `workdir: ${errText(e)}`,
      outboundChars: s.ok ? s.outboundChars : 0,
    })
    return
  }

  let scopeChanged = false
  const displaySignals = createTurnDisplaySignals()
  const c = getConversation(identity)
  const ref = c ? resolvedSessionRef(c, r.vendor) : null
  let result: RobotTurnResult
  try {
    result = await runner({
      robotId: r.id,
      workspacePath: robotWorkdir(r.name),
      imAuth: {
        senderId: m.senderId,
        chatType: m.chatType,
        chatId: m.chatId,
        providerAccountKey: providerAccountKeyOf(r.platform, r.appId),
        platform: r.platform,
        expectedBindingId: identity.bindingId,
        turnStartScopeHash: turnScopeHash,
        displaySignals,
        onScopeChanged: () => {
          scopeChanged = true
        },
      },
      ...(ref ? { sessionId: ref.sessionId } : {}),
      prompt: ref ? m.text : formatContextSeed(loadCommittedContext(identity), m.text),
      maxTurnMs: r.maxTurnMs ?? ROBOT_DEFAULT_MAX_TURN_MS,
      signal: new AbortController().signal,
    })
  } catch (e) {
    fail(contextTurnId)
    const s = await fixed(
      h,
      { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
      target,
      ctx,
    )
    finishTurn(turnId, {
      outcome: 'error',
      error: `run: ${errText(e)}`,
      outboundChars: s.ok ? s.outboundChars : 0,
    })
    return
  }

  const chat = chatContextFor(r.platform, r.appId, m.chatType, m.chatId)
  const live = resolveCallScope({
    robotId: r.id,
    senderId: m.senderId,
    chat,
    expectedBindingId: identity.bindingId,
  })
  if (!live.ok) {
    fail(contextTurnId)
    const s = await bindingNotice(h, identityRequiredRef(m.chatType), target, ctx)
    finishTurn(turnId, {
      outcome: 'identity_required',
      sessionId: result.sessionId,
      outboundChars: s.ok ? s.outboundChars : 0,
      outMessageId: s.ok ? s.messageId : null,
      error: s.ok ? null : s.reason,
    })
    return
  }
  if (scopeChanged || live.scope.scopeHash !== turnScopeHash) {
    fail(contextTurnId)
    const s = await bindingNotice(h, { key: 'binding.scopeChanged', params: {} }, target, ctx)
    finishTurn(turnId, {
      outcome: 'scope_changed',
      sessionId: result.sessionId,
      outboundChars: s.ok ? s.outboundChars : 0,
      outMessageId: s.ok ? s.messageId : null,
      error: s.ok ? null : s.reason,
    })
    return
  }

  const securityMsg = pickSecurityMessage(displaySignals, m.chatType)
  if (securityMsg) {
    fail(contextTurnId)
    const s = await fixed(h, securityMsg, target, ctx)
    finishTurn(turnId, {
      outcome: 'complete',
      sessionId: result.sessionId,
      outboundChars: s.ok ? s.outboundChars : 0,
      outMessageId: s.ok ? s.messageId : null,
      error: s.ok ? null : s.reason,
    })
    if (s.ok) {
      commitContextTurn({
        contextTurnId,
        userText: m.text,
        assistantText: s.text,
        sessionId: result.sessionId,
        vendor: r.vendor,
      })
    }
    return
  }

  if (result.outcome !== 'complete' || !result.lastMessage.trim()) {
    const o: ImTurnOutcome = result.outcome === 'complete' ? 'error' : result.outcome
    fail(contextTurnId)
    const runtimeMsg = outcomeToRuntimeMessage(o) ?? {
      key: 'runtime.error',
      params: { nav: { kind: 'webEntry' } },
    }
    const s = await fixed(h, runtimeMsg, target, ctx)
    finishTurn(turnId, {
      outcome: o,
      sessionId: result.sessionId,
      error: result.detail ? errText(result.detail) : s.ok ? null : s.reason,
      outboundChars: s.ok ? s.outboundChars : 0,
      outMessageId: s.ok ? s.messageId : null,
    })
    return
  }
  const s = await h.sendOutbound(
    { category: 'final_answer', text: result.lastMessage },
    target,
    ctx,
  )
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
  const h = handles?.get(id)
  const r = getRobot(id)
  if (!h || !r || !r.enabled || !m.senderId.trim()) return
  const target = targetOf(m)
  const ctx = renderCtx(r)

  if (!isStoreAvailable() || !isIdentityStoreAvailable()) {
    void fixed(h, { key: 'runtime.storeUnavailable', params: {} }, target, ctx)
    return
  }

  void (async () => {
    const tokenText = m.text.trim()
    if (parseTodoInbound(tokenText)) {
      if (m.chatType === 'group' && !accepts(r, m)) return
      if (
        await handleTodoControl(r, m, {
          sendFixed: async (message, t, c) => {
            const s = await fixed(h, message, t, c)
            return {
              ok: s.ok,
              outboundChars: s.ok ? s.outboundChars : 0,
              messageId: s.ok ? s.messageId : null,
              reason: s.ok ? undefined : s.reason,
            }
          },
          renderCtx: (subject) => renderCtx(r, subject),
          accepts,
          broadcastIntents: deps?.broadcastIntents,
        })
      ) {
        return
      }
    }
    if (TOKEN_SHAPE.test(tokenText)) {
      if (m.chatType === 'group' && !accepts(r, m)) return
      if (await handleBindingControl(r, h, m)) return
    }

    const ns = accountNamespaceOf(r.platform, r.appId)
    const binding = getActiveBindingForSender(ns, m.senderId)
    if (!binding) {
      if (m.chatType === 'group' && !accepts(r, m)) return
      const gate = await claimControlMessage(r, h, m)
      if (gate !== 'claimed') return
      await auditedBindingNotice(r, h, m, identityRequiredRef(m.chatType), 'identity_required')
      return
    }

    if (!accepts(r, m)) return

    const chat = chatContextFor(r.platform, r.appId, m.chatType, m.chatId)
    const scope = resolveCallScope({
      robotId: r.id,
      senderId: m.senderId,
      chat,
      expectedBindingId: binding.id,
    })
    if (!scope.ok) {
      const tid = beginTurn({
        robotId: r.id,
        threadKey: threadKeyFor(m),
        chatId: m.chatId,
        senderId: m.senderId,
        messageId: m.messageId,
      })
      const s = await bindingNotice(
        h,
        identityRequiredRef(m.chatType),
        target,
        renderCtx(r, binding.subject),
      )
      finishTurn(tid, {
        outcome: 'identity_required',
        outboundChars: s.ok ? s.outboundChars : 0,
        outMessageId: s.ok ? s.messageId : null,
        error: s.ok ? null : s.reason,
      })
      return
    }

    const threadKey = threadKeyFor(m)
    const identity = conversationIdentityOf(
      r.platform,
      r.id,
      threadKey,
      m.senderId,
      binding.id,
      binding.subject,
      scope.scope.scopeHash,
    )
    const gate = conversationGateKey(identity)

    if (inFlight.has(gate)) {
      let claim: ReturnType<typeof claimInboundMessage>
      try {
        claim = claimInboundMessage({
          ...identity,
          chatId: m.chatId,
          vendor: r.vendor,
          messageId: m.messageId,
          forRun: false,
        })
      } catch (e) {
        void fixed(
          h,
          e instanceof RobotStoreError && e.code === 'db_unavailable'
            ? { key: 'runtime.storeUnavailable', params: {} }
            : { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
          target,
          renderCtx(r, binding.subject),
        )
        return
      }
      if (claim.kind === 'duplicate') return
      const tid = beginTurn({
        robotId: r.id,
        threadKey,
        chatId: m.chatId,
        senderId: m.senderId,
        messageId: m.messageId,
      })
      void fixed(h, { key: 'runtime.busy', params: {} }, target, renderCtx(r, binding.subject))
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
        ...identity,
        chatId: m.chatId,
        vendor: r.vendor,
        messageId: m.messageId,
        forRun: true,
      })
    } catch (e) {
      inFlight.delete(gate)
      release()
      void fixed(
        h,
        e instanceof RobotStoreError && e.code === 'db_unavailable'
          ? { key: 'runtime.storeUnavailable', params: {} }
          : { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
        target,
        renderCtx(r, binding.subject),
      )
      return
    }
    if (claim.kind !== 'claimed') {
      inFlight.delete(gate)
      release()
      return
    }
    const running = runOneTurn(
      r,
      h,
      m,
      threadKey,
      claim.contextTurnId,
      identity,
      scope.scope.scopeHash,
    )
      .catch((e) => {
        console.error('[c3][im] turn failed:', errText(e))
        fail(claim.contextTurnId)
      })
      .finally(() => {
        inFlight.delete(gate)
        release()
      })
    inFlight.set(gate, running)
  })()
}

function wrapHandle(
  robotId: string,
  c: { status: () => ImConnectionStatus; send: RawImSend; close: () => Promise<void> },
  capabilities: ImProviderCapabilities,
): RobotHandle {
  return {
    status: c.status,
    close: c.close,
    maxOutboundChars: capabilities.maxOutboundChars,
    rawSend: c.send,
    sendOutbound: (content, target, renderContext) =>
      sendGuarded({
        robotId,
        target,
        content,
        maxOutboundChars: capabilities.maxOutboundChars,
        renderContext,
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
  if (handles || !isStoreAvailable() || !isIdentityStoreAvailable()) return
  deps = input
  handles = new Map()
  registerRobotHandleLookup((robotId) => {
    const h = handles?.get(robotId)
    if (!h) return null
    return { maxOutboundChars: h.maxOutboundChars, rawSend: h.rawSend }
  })
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
