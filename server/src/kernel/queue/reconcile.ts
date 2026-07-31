/**
 * Queue scheduling kernel — the pure reconcile pass.
 *
 * One call takes a full picture of the world (clock, ledger snapshot, run
 * liveness, persisted per-intent scheduling metadata, user controls) and returns
 * the actions to perform plus a per-intent decision record. It performs no I/O,
 * mutates none of its inputs and is fully deterministic: the same input always
 * yields the same output, so repeating a pass can never double-launch, double-
 * count a failure or duplicate a human todo.
 *
 * Nothing here knows how the pass was triggered. A timer tick, a coalesced dirty
 * mark from a lifecycle event and the one-shot pass at server startup all enter
 * through this same function, which is why a dropped event costs at most one
 * cycle of latency instead of stalling the queue.
 *
 * Gate order is fixed and never relaxed: park → force-skip → spec approval →
 * dependencies (including worktree-mode "dependency PR merged") → backoff →
 * cooldown, then the workspace-global concurrency gate. A parked intent is not
 * `done`, so its downstream stays blocked by the dependency gate exactly as
 * before — parking isolates a failure, it never opens a path around one.
 */
import type {
  QueueAction,
  QueueDecision,
  QueueIntentFact,
  QueueIntentMeta,
  QueueProjectedState,
  QueueReasonCode,
  QueueReconcileInput,
  QueueReconcileOutput,
  QueueRunFact,
} from './types.js'
import {
  QUEUE_PERMISSION_WAIT_MS,
  QUEUE_RUN_ORIGIN,
  QUEUE_TICK_MS,
  emptyQueueIntentMeta,
} from './types.js'

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 } as const

/** A candidate's gate outcome for this pass. */
interface GateResult {
  eligible: boolean
  reason: QueueReasonCode
  detail: string
  /** When the blocking condition expires by itself (backoff / cooldown). */
  wakeAt: number | null
}

/** Reconcile one workspace's queue. Pure. */
export function reconcileQueue(input: QueueReconcileInput): QueueReconcileOutput {
  const { now, tickId, control, intents, meta, gitBranchMode, sddEnabled } = input

  const wakeups: number[] = []
  const noteWake = (at: number | null): void => {
    if (at !== null && at > now) wakeups.push(at)
  }
  const finish = (
    state: QueueProjectedState,
    actions: QueueAction[],
    decisions: QueueDecision[],
    current: { intentId: string | null; sessionId: string | null; awaitingPermission: boolean },
  ): QueueReconcileOutput => ({
    tickId,
    state,
    actions,
    decisions,
    nextWakeupAt: wakeups.length > 0 ? Math.min(...wakeups) : now + QUEUE_TICK_MS,
    currentIntentId: current.intentId,
    currentSessionId: current.sessionId,
    awaitingPermission: current.awaitingPermission,
  })
  const idle = { intentId: null, sessionId: null, awaitingPermission: false }

  // ── Queue not started: nothing is scheduled, facts are left untouched. ──
  if (control.state === 'idle') {
    return finish('idle', [], [], idle)
  }

  // ── Fail closed on an unreadable snapshot: never launch on a blind guess. ──
  if (!input.snapshotOk) {
    return finish(
      'running',
      [],
      [
        {
          intentId: '',
          action: 'block',
          reason: 'snapshot_unavailable',
          detail: '意图快照不可读,本轮不做任何启动',
          attemptCount: 0,
          backoffCount: 0,
          nextWakeupAt: null,
        },
      ],
      idle,
    )
  }

  const byId = new Map(intents.map((r) => [r.id, r]))
  const runById = new Map<string, QueueRunFact>(input.runs.map((r) => [r.sessionId, r]))
  const metaOf = (id: string): QueueIntentMeta => meta[id] ?? emptyQueueIntentMeta(id)
  const inFlight = new Set(input.inFlight)
  const forceSkipped = new Set(control.forceSkipped)

  const actions: QueueAction[] = []
  const decisions: QueueDecision[] = []
  const pushDecision = (
    intent: QueueIntentFact,
    action: QueueDecision['action'],
    reason: QueueReasonCode,
    detail: string,
    nextWakeupAt: number | null = null,
  ): void => {
    const m = metaOf(intent.id)
    decisions.push({
      intentId: intent.id,
      action,
      reason,
      detail,
      attemptCount: m.failureCount,
      backoffCount: m.backoffCount,
      nextWakeupAt,
    })
  }

  // ── Run liveness view ─────────────────────────────────────────────────────
  // RM-A12 reads EVERY in_progress intent, automated or not: a manual work
  // session still owns the workspace.
  const liveIntents = intents.filter(
    (r) =>
      r.status === 'in_progress' &&
      !!r.lastWorkSessionId &&
      runById.get(r.lastWorkSessionId) !== undefined &&
      runById.get(r.lastWorkSessionId)!.alive,
  )
  const liveRunOf = (r: QueueIntentFact): QueueRunFact | undefined =>
    r.lastWorkSessionId ? runById.get(r.lastWorkSessionId) : undefined
  const awaitingPermission = liveIntents.some((r) => liveRunOf(r)?.awaitingPermissionSince != null)

  // ── Permission waits that outlived the queue's patience ───────────────────
  // The DECISION never times out and is never auto-answered; only the queue's
  // own waiting does. The run is left alive and untouched (C-SEC-3) — the queue
  // simply stops tracking this intent and asks a human to step in.
  const parkedThisPass = new Set<string>()
  for (const intent of liveIntents) {
    if (!intent.automate) continue
    const since = liveRunOf(intent)?.awaitingPermissionSince
    if (since == null || now - since < QUEUE_PERMISSION_WAIT_MS) continue
    if (metaOf(intent.id).parked) continue
    const detail = '权限提示长时间无人应答,已交回人工'
    actions.push({ kind: 'park', intentId: intent.id, reason: 'permission_wait_timeout', detail })
    actions.push({
      kind: 'wait_user_involve',
      intentId: intent.id,
      reason: 'permission_wait_timeout',
      detail,
    })
    pushDecision(intent, 'park', 'permission_wait_timeout', detail)
    parkedThisPass.add(intent.id)
  }

  // ── Paused: no launches, facts and metadata are preserved verbatim ────────
  if (control.state === 'paused') {
    for (const intent of intents) {
      if (!intent.automate) continue
      if (intent.status !== 'todo' && intent.status !== 'in_progress') continue
      if (parkedThisPass.has(intent.id)) continue
      pushDecision(intent, 'block', 'queue_paused', '队列已暂停')
    }
    const blocking = liveIntents[0]
    return finish('paused', actions, decisions, {
      intentId: blocking?.id ?? null,
      sessionId: blocking?.lastWorkSessionId ?? null,
      awaitingPermission,
    })
  }

  // ── Per-candidate gates ───────────────────────────────────────────────────
  const evaluate = (intent: QueueIntentFact): GateResult => {
    const m = metaOf(intent.id)
    if (m.parked || parkedThisPass.has(intent.id)) {
      const reason = m.parkReason ?? 'max_attempts_reached'
      return {
        eligible: false,
        reason: 'blocked_parked',
        detail: m.parkDetail ?? `已 park(${reason})`,
        wakeAt: null,
      }
    }
    if (forceSkipped.has(intent.id)) {
      return {
        eligible: false,
        reason: 'blocked_force_skipped',
        detail: '用户已强制跳过本轮选择',
        wakeAt: null,
      }
    }
    if (sddEnabled && !intent.specApproved) {
      return {
        eligible: false,
        reason: 'blocked_spec_not_approved',
        detail: 'SDD 已开启但 spec 未批准',
        wakeAt: null,
      }
    }
    for (const depId of intent.dependsOn) {
      const dep = byId.get(depId)
      // An unknown dependency (cross-workspace / deleted) never blocks.
      if (!dep) continue
      if (dep.status !== 'done') {
        return {
          eligible: false,
          reason: 'blocked_dependency',
          detail: `依赖「${dep.title}」尚未完成(${dep.status})`,
          wakeAt: null,
        }
      }
      if (gitBranchMode === 'worktree' && dep.prStatus !== 'merged') {
        return {
          eligible: false,
          reason: 'blocked_dependency_pr_unmerged',
          detail: `依赖「${dep.title}」的 PR 未确认合并`,
          wakeAt: null,
        }
      }
    }
    if (m.backoffUntil !== null && m.backoffUntil > now) {
      return {
        eligible: false,
        reason: 'blocked_backoff',
        detail: `第 ${m.failureCount} 次失败后退避中`,
        wakeAt: m.backoffUntil,
      }
    }
    if (m.cooldownUntil !== null && m.cooldownUntil > now) {
      return {
        eligible: false,
        reason: 'blocked_cooldown',
        detail: '刚发起过一次内核 run,冷却中',
        wakeAt: m.cooldownUntil,
      }
    }
    return { eligible: true, reason: 'selected', detail: '', wakeAt: null }
  }

  const candidates = intents.filter(
    (r) => r.automate && (r.status === 'todo' || r.status === 'in_progress'),
  )
  candidates.sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt,
  )

  const eligible: QueueIntentFact[] = []
  const gateOf = new Map<string, GateResult>()
  const unmergedDepIds = new Set<string>()
  for (const intent of candidates) {
    const gate = evaluate(intent)
    gateOf.set(intent.id, gate)
    noteWake(gate.wakeAt)
    if (gate.eligible) eligible.push(intent)
    if (gate.reason === 'blocked_dependency_pr_unmerged') {
      for (const depId of intent.dependsOn) {
        const dep = byId.get(depId)
        if (dep && dep.status === 'done' && dep.prStatus !== 'merged') unmergedDepIds.add(dep.id)
      }
    }
  }

  // ── Something the kernel already drives → observe, never re-launch ────────
  const owned = candidates.find((r) => inFlight.has(r.id))
  if (owned) {
    pushDecision(owned, 'wait', 'running', '内核 run 进行中')
    for (const intent of candidates) {
      if (intent.id === owned.id || parkedThisPass.has(intent.id)) continue
      const gate = gateOf.get(intent.id)!
      pushDecision(
        intent,
        gate.eligible ? 'wait' : 'block',
        gate.eligible ? 'blocked_concurrency_gate' : gate.reason,
        gate.eligible ? '队列串行执行,等待当前意图结束' : gate.detail,
        gate.wakeAt,
      )
    }
    return finish('developing', actions, decisions, {
      intentId: owned.id,
      sessionId: owned.lastWorkSessionId,
      awaitingPermission,
    })
  }

  // ── A live session the kernel does NOT own ────────────────────────────────
  // An eligible candidate whose own session is still running is attached to
  // (a run outlives its turn — never start a second one). Anything else that is
  // alive holds the workspace-global concurrency gate shut.
  const blocking = liveIntents[0]
  if (blocking) {
    const attachable =
      blocking.automate &&
      gateOf.get(blocking.id)?.eligible === true &&
      !parkedThisPass.has(blocking.id)
    if (attachable && blocking.lastWorkSessionId) {
      actions.push({
        kind: 'attach',
        intentId: blocking.id,
        sessionId: blocking.lastWorkSessionId,
        origin: QUEUE_RUN_ORIGIN,
      })
      pushDecision(blocking, 'attach', 'attached_running', '会话仍在运行,挂接观察而非重复启动')
    }
    for (const intent of candidates) {
      if (intent.id === blocking.id || parkedThisPass.has(intent.id)) continue
      const gate = gateOf.get(intent.id)!
      pushDecision(
        intent,
        gate.eligible ? 'wait' : 'block',
        gate.eligible ? 'blocked_concurrency_gate' : gate.reason,
        gate.eligible ? `全局并发闸门:「${blocking.title}」的工作会话仍在运行` : gate.detail,
        gate.wakeAt,
      )
    }
    if (!attachable && !gateOf.has(blocking.id)) {
      // The blocker is a manual (non-automate) intent — record why we wait.
      decisions.push({
        intentId: blocking.id,
        action: 'block',
        reason: 'blocked_concurrency_gate',
        detail: `「${blocking.title}」为非自动化意图,其工作会话仍在运行`,
        attemptCount: 0,
        backoffCount: 0,
        nextWakeupAt: null,
      })
    }
    return finish(attachable ? 'developing' : 'awaiting_gate', actions, decisions, {
      intentId: blocking.id,
      sessionId: blocking.lastWorkSessionId,
      awaitingPermission,
    })
  }

  // ── Gate clear → select at most one intent ────────────────────────────────
  const picked = eligible[0] ?? null
  if (picked) {
    // `in_progress` with a session that is NOT alive: resume the existing
    // context. A dead blocking session releases `awaiting_gate` by construction —
    // it never appears in `liveIntents`.
    if (picked.status === 'in_progress' && picked.lastWorkSessionId) {
      actions.push({
        kind: 'resume',
        intentId: picked.id,
        sessionId: picked.lastWorkSessionId,
        origin: QUEUE_RUN_ORIGIN,
      })
      pushDecision(picked, 'resume', 'resumed', '恢复既有工作会话继续开发')
    } else {
      actions.push({ kind: 'launch', intentId: picked.id, origin: QUEUE_RUN_ORIGIN })
      pushDecision(picked, 'launch', 'selected', '本轮选中,启动全新工作会话')
    }
  }

  for (const intent of candidates) {
    if (picked && intent.id === picked.id) continue
    if (parkedThisPass.has(intent.id)) continue
    const gate = gateOf.get(intent.id)!
    pushDecision(
      intent,
      gate.eligible ? 'wait' : 'block',
      gate.eligible ? 'blocked_concurrency_gate' : gate.reason,
      gate.eligible ? '队列串行执行,等待前序意图结束' : gate.detail,
      gate.wakeAt,
    )
  }

  // Nothing runnable purely because dependency PR states are stale → refresh.
  if (!picked && unmergedDepIds.size > 0) {
    actions.push({ kind: 'sync_dependency_prs', intentIds: [...unmergedDepIds] })
  }

  if (picked) {
    return finish('developing', actions, decisions, {
      intentId: picked.id,
      sessionId: picked.lastWorkSessionId,
      awaitingPermission,
    })
  }

  // A queue with recoverable, backing-off, parked or gated candidates is NOT
  // done — `done` means the snapshot holds no pending automation work at all.
  const stillPending = candidates.length > 0
  return finish(stillPending ? 'running' : 'done', actions, decisions, idle)
}
