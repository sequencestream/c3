import type { ImConnectionStatus, ImRobot } from '@ccc/shared/protocol'
import type { RunRobotTurnInput, RobotTurnResult } from '../../wiring/robot-turn.js'
import { isIdentityStoreAvailable } from './identity-store.js'
import { evaluateInboundSyncAdmission, processInboundAdmission } from './inbound-admission.js'
import { resolveImProvider } from './registry.js'
import { runOneTurn } from './robot-turn-runner.js'
import { registerRobotHandleLookup } from './supervisor-access.js'
import {
  beginTurn,
  claimInboundMessage,
  finishTurn,
  getRobot,
  isStoreAvailable,
  listEnabledRobots,
  robotSecret,
  RobotStoreError,
} from './robot-store.js'
import { conversationGateKey } from './thread-key.js'
import {
  errText,
  fail,
  fixed,
  renderCtx,
  robotWorkdir,
  targetOf,
  wrapHandle,
  type RobotHandle,
} from './supervisor-internal.js'
import {
  logImConnectFailed,
  logImConnected,
  logImConnecting,
  logImConnectionState,
  logImInbound,
} from './im-log.js'
import type { ImInboundMessage } from './types.js'

export interface ImSupervisorDeps {
  runTurn: (input: RunRobotTurnInput) => Promise<RobotTurnResult>
  broadcastIntents?: (workspacePath: string) => void
}

export { robotWorkdir }

let deps: ImSupervisorDeps | null = null
let handles: Map<string, RobotHandle> | null = null
const inFlight = new Map<string, Promise<void>>()
const failures = new Map<string, string>()

function onInbound(id: string, m: ImInboundMessage): void {
  const h = handles?.get(id)
  const r = getRobot(id)
  const sync = evaluateInboundSyncAdmission(h, r, m)
  if (sync.kind === 'reject') return

  logImInbound({ robot: sync.robot, message: m })
  void dispatchAfterAdmission(sync.robot, sync.handle, m)
}

async function dispatchAfterAdmission(
  robot: ImRobot,
  handle: RobotHandle,
  m: ImInboundMessage,
): Promise<void> {
  const admission = await processInboundAdmission(robot, handle, m, {
    broadcastIntents: deps?.broadcastIntents,
  })
  if (admission.kind !== 'start_turn') return

  const { binding, scope, threadKey, identity } = admission
  const target = targetOf(m)
  const gate = conversationGateKey(identity)

  if (inFlight.has(gate)) {
    let claim: ReturnType<typeof claimInboundMessage>
    try {
      claim = claimInboundMessage({
        ...identity,
        chatId: m.chatId,
        vendor: robot.vendor,
        messageId: m.messageId,
        forRun: false,
      })
    } catch (e) {
      void fixed(
        handle,
        e instanceof RobotStoreError && e.code === 'db_unavailable'
          ? { key: 'runtime.storeUnavailable', params: {} }
          : { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
        target,
        renderCtx(robot, binding.subject),
      )
      return
    }
    if (claim.kind === 'duplicate') return
    const tid = beginTurn({
      robotId: robot.id,
      threadKey,
      chatId: m.chatId,
      senderId: m.senderId,
      messageId: m.messageId,
    })
    void fixed(
      handle,
      { key: 'runtime.busy', params: {} },
      target,
      renderCtx(robot, binding.subject),
    )
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
      vendor: robot.vendor,
      messageId: m.messageId,
      forRun: true,
    })
  } catch (e) {
    inFlight.delete(gate)
    release()
    void fixed(
      handle,
      e instanceof RobotStoreError && e.code === 'db_unavailable'
        ? { key: 'runtime.storeUnavailable', params: {} }
        : { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } },
      target,
      renderCtx(robot, binding.subject),
    )
    return
  }
  if (claim.kind !== 'claimed') {
    inFlight.delete(gate)
    release()
    return
  }
  const runner = deps
  if (!runner) {
    inFlight.delete(gate)
    release()
    return
  }
  const running = runOneTurn(
    robot,
    handle,
    m,
    threadKey,
    claim.contextTurnId,
    identity,
    scope.scopeHash,
    runner,
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
}

async function connectRobot(r: ImRobot): Promise<void> {
  const p = resolveImProvider(r.platform)
  if (!p) {
    failures.set(r.id, `platform ${r.platform} is not supported by this build`)
    logImConnectFailed(r, failures.get(r.id)!)
    return
  }
  logImConnecting(r)
  try {
    const c = await p.connect({
      robotId: r.id,
      appId: r.appId,
      appSecret: robotSecret(r.id),
      onMessage: (m) => onInbound(r.id, m),
      onStateChange: (s) => logImConnectionState(r, s),
    })
    handles?.set(r.id, wrapHandle(r.id, c, p.capabilities))
    failures.delete(r.id)
    logImConnected(r, c.status())
  } catch (e) {
    failures.set(r.id, errText(e))
    logImConnectFailed(r, errText(e))
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
