import { mkdirSync } from 'node:fs'
import type { ImRobot, ImTurnOutcome } from '@ccc/shared/protocol'
import { ROBOT_DEFAULT_MAX_TURN_MS } from '@ccc/shared/protocol'
import type {
  RobotTurnProgress,
  RobotTurnResult,
  RunRobotTurnInput,
} from '../../wiring/robot-turn.js'
import { providerAccountKeyOf } from './identity-store.js'
import { chatContextFor, resolveCallScope } from './call-scope.js'
import { formatContextSeed } from './context-seed.js'
import { screenInbound } from './inbound-guard.js'
import type { OutboundTarget, RobotMessageRef } from './outbound-guard.js'
import type { RobotRenderContext } from './robot-message-registry.js'
import {
  createTurnDisplaySignals,
  outcomeToRuntimeMessage,
  pickSecurityMessage,
  runtimeInputTooLongRef,
} from './robot-message-registry.js'
import {
  beginTurn,
  commitContextTurn,
  finishTurn,
  getConversation,
  loadCommittedContext,
  resolvedSessionRef,
} from './robot-store.js'
import { conversationIdentityOf } from './thread-key.js'
import type { ImInboundMessage } from './types.js'
import {
  bindingNotice,
  errText,
  fail,
  fixed,
  identityRequiredRef,
  renderCtx,
  robotWorkdir,
  targetOf,
  type RobotHandle,
} from './supervisor-internal.js'

/** Progress delivery tuning — product knobs, concentrated in one place. */
const PROGRESS_GRACE_MS = 2000
const PROGRESS_MIN_INTERVAL_MS = 5000
const PROGRESS_MAX_PER_TURN = 3

function progressStage(frame: RobotTurnProgress): number {
  switch (frame.kind) {
    case 'accepted':
      return 0
    case 'step_started':
      return 1
    case 'step_done':
      return 2
  }
}

function progressRef(frame: RobotTurnProgress): RobotMessageRef {
  switch (frame.kind) {
    case 'accepted':
      return { key: 'progress.received', params: {} }
    case 'step_started':
      return { key: 'progress.step', params: { step: frame.step } }
    case 'step_done':
      return { key: 'progress.continued', params: {} }
  }
}

function createTurnProgress(
  h: RobotHandle,
  target: OutboundTarget,
  ctx: RobotRenderContext,
): { push: (frame: RobotTurnProgress) => void; end: () => void } {
  const startedAt = Date.now()
  let pending: RobotTurnProgress[] = []
  let stageConsumed = -1
  let sentCount = 0
  let lastSentAt = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const dispatch = (frame: RobotTurnProgress): void => {
    stageConsumed = progressStage(frame)
    sentCount += 1
    lastSentAt = Date.now()
    void h
      .sendOutbound({ category: 'fixed_notice', message: progressRef(frame) }, target, ctx)
      .catch((err) => console.error('[c3][im] progress send failed:', errText(err)))
  }

  const armAfter = (delay: number): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      flushNow()
    }, delay)
    timer.unref?.()
  }

  const arm = (): void => {
    if (timer) return
    if (pending.length === 0 || sentCount >= PROGRESS_MAX_PER_TURN) return
    const elapsed = Date.now() - startedAt
    const graceRemain = Math.max(0, PROGRESS_GRACE_MS - elapsed)
    const intervalRemain =
      lastSentAt === -Infinity
        ? 0
        : Math.max(0, PROGRESS_MIN_INTERVAL_MS - (Date.now() - lastSentAt))
    armAfter(Math.max(graceRemain, intervalRemain))
  }

  const flushNow = (): void => {
    clearTimer()
    while (pending.length > 0) {
      const frame = pending[0]
      const stage = progressStage(frame)
      if (stage !== stageConsumed && stage !== stageConsumed + 1) {
        pending.shift()
        continue
      }
      if (sentCount >= PROGRESS_MAX_PER_TURN) {
        pending = []
        return
      }
      if (Date.now() - startedAt < PROGRESS_GRACE_MS) {
        arm()
        return
      }
      if (lastSentAt !== -Infinity && Date.now() - lastSentAt < PROGRESS_MIN_INTERVAL_MS) {
        arm()
        return
      }
      pending.shift()
      dispatch(frame)
    }
  }

  return {
    push: (frame) => {
      pending.push(frame)
      arm()
    },
    end: () => {
      clearTimer()
      if (Date.now() - startedAt < PROGRESS_GRACE_MS) {
        pending = []
        return
      }
      while (pending.length > 0) {
        const frame = pending[0]
        const stage = progressStage(frame)
        if (stage !== stageConsumed && stage !== stageConsumed + 1) {
          pending.shift()
          continue
        }
        if (sentCount >= PROGRESS_MAX_PER_TURN) break
        if (lastSentAt !== -Infinity && Date.now() - lastSentAt < PROGRESS_MIN_INTERVAL_MS) break
        pending.shift()
        dispatch(frame)
      }
      pending = []
    },
  }
}

export interface RobotTurnRunnerDeps {
  runTurn: (input: RunRobotTurnInput) => Promise<RobotTurnResult>
}

export async function runOneTurn(
  r: ImRobot,
  h: RobotHandle,
  m: ImInboundMessage,
  threadKey: string,
  contextTurnId: string,
  identity: ReturnType<typeof conversationIdentityOf>,
  turnScopeHash: string,
  deps: RobotTurnRunnerDeps,
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
  const runner = deps.runTurn
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
  const progress = createTurnProgress(h, target, ctx)
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
      onProgress: progress.push,
    })
    progress.end()
  } catch (e) {
    progress.end()
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

export {
  PROGRESS_GRACE_MS,
  PROGRESS_MAX_PER_TURN,
  PROGRESS_MIN_INTERVAL_MS,
  createTurnProgress,
  progressRef,
  progressStage,
}
