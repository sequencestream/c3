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
 * cooldown, then the concurrency gate. A parked intent is not `done`, so its
 * downstream stays blocked by the dependency gate exactly as before — parking
 * isolates a failure, it never opens a path around one.
 *
 * The concurrency gate is the one rule whose SCOPE depends on the workspace: it
 * exists to keep two work sessions off the same files, so it is workspace-global
 * under `current-branch` (one shared checkout) and per-intent under `worktree`
 * (a directory each). Everything else is identical in both modes.
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
  QUEUE_MAX_SPEC_REWORK,
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

/**
 * What the spec phase decided for one intent that failed the spec-approval gate.
 * It REPLACES that intent's `blocked_spec_not_approved` verdict for this pass, so
 * the decision log shows the actual sub-state (authoring / reviewing / reworking /
 * awaiting approval) instead of one opaque "spec not approved" forever.
 */
interface SpecVerdict {
  action: QueueDecision['action']
  reason: QueueReasonCode
  detail: string
  /** The side effect to perform, when this verdict has one. */
  actions: QueueAction[]
  /**
   * True when the verdict starts an AGENT session and must therefore take the
   * workspace's single spec-phase slot. A machine approval and a human-todo
   * escalation are plain writes, so they never queue behind a running session.
   */
  needsSlot: boolean
  wakeAt: number | null
}

/** Reconcile one workspace's queue. Pure. */
export function reconcileQueue(input: QueueReconcileInput): QueueReconcileOutput {
  const { now, tickId, control, intents, meta, gitBranchMode, sddEnabled } = input

  const wakeups: number[] = []
  const noteWake = (at: number | null): void => {
    if (at !== null && at > now) wakeups.push(at)
  }
  /**
   * The candidates that cleared every gate this pass, in selection order. Empty
   * until the gates have run; `finish` numbers the gate-blocked ones from it, so
   * every exit reports positions built the one way.
   */
  let eligibleOrder: readonly QueueIntentFact[] = []
  const finish = (
    state: QueueProjectedState,
    actions: QueueAction[],
    decisions: QueueDecision[],
    current: { intentId: string | null; sessionId: string | null; awaitingPermission: boolean },
  ): QueueReconcileOutput => {
    stampQueuePositions(decisions, eligibleOrder)
    return {
      tickId,
      state,
      actions,
      decisions,
      nextWakeupAt: wakeups.length > 0 ? Math.min(...wakeups) : now + QUEUE_TICK_MS,
      currentIntentId: current.intentId,
      currentSessionId: current.sessionId,
      awaitingPermission: current.awaitingPermission,
    }
  }
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
          queuePosition: null,
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
      queuePosition: null,
    })
  }

  // ── Run liveness view ─────────────────────────────────────────────────────
  // RM-A12 reads EVERY in_progress intent, automated or not: under a shared
  // checkout a manual work session still owns the workspace.
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
    // The spec gate reads the STATUS and nothing else: `raw` (still being
    // authored) and `pending` (authored, unapproved) both fail it, and the
    // spec phase below says which of the two an intent is actually in.
    if (sddEnabled && intent.specStatus !== 'approved') {
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
  eligibleOrder = eligible

  // ── Spec phase ────────────────────────────────────────────────────────────
  // Everything blocked purely by `blocked_spec_not_approved` is not "stuck": in
  // an SDD workspace the queue owns the spec's whole life — author it, review it
  // read-only, rework it up to the cap, and (only under the workspace's explicit
  // opt-in) approve it. Each such intent's verdict REPLACES its gate verdict
  // below, so a decision row says which sub-state it is actually in.
  //
  // At most ONE session-starting verdict fires per pass, mirroring the work
  // queue's serial execution: writing and reviewing specs costs real tokens, and
  // an SDD workspace that just enabled automation would otherwise fan out a spec
  // session per pending intent at once. Plain writes (machine approval, the
  // rework-cap escalation) do not take that slot.
  const specVerdictOf = new Map<string, SpecVerdict>()
  if (sddEnabled) {
    const specAlive = new Map(input.specRuns.map((r) => [r.sessionId, r.alive]))
    const specInFlight = new Set(input.specInFlight)
    const specPhase = candidates.filter(
      (r) => gateOf.get(r.id)?.reason === 'blocked_spec_not_approved',
    )
    let slotTaken = false
    for (const intent of specPhase) {
      const verdict = evaluateSpecPhase(intent, {
        now,
        meta: metaOf(intent.id),
        alive: (id: string | null) => !!id && specAlive.get(id) === true,
        inFlight: specInFlight.has(intent.id),
        machineApprovalEnabled: input.machineApprovalEnabled,
      })
      if (verdict.needsSlot && slotTaken) {
        specVerdictOf.set(intent.id, {
          action: 'wait',
          reason: 'blocked_concurrency_gate',
          detail: '队列串行执行规格阶段,等待前序意图的 spec 会话结束',
          actions: [],
          needsSlot: false,
          wakeAt: null,
        })
        continue
      }
      if (verdict.needsSlot) slotTaken = true
      specVerdictOf.set(intent.id, verdict)
      actions.push(...verdict.actions)
      noteWake(verdict.wakeAt)
    }
  }

  /**
   * Record one candidate's verdict, preferring its spec-phase sub-state over the
   * raw gate result. Every place that reports on non-selected candidates goes
   * through here, so the three branches below cannot disagree about what a
   * spec-phase intent is doing.
   */
  const pushGateOrSpec = (
    intent: QueueIntentFact,
    gate: GateResult,
    eligibleDetail: string,
  ): void => {
    const spec = specVerdictOf.get(intent.id)
    if (spec) {
      pushDecision(intent, spec.action, spec.reason, spec.detail, spec.wakeAt)
      return
    }
    pushDecision(
      intent,
      gate.eligible ? 'wait' : 'block',
      gate.eligible ? 'blocked_concurrency_gate' : gate.reason,
      gate.eligible ? eligibleDetail : gate.detail,
      gate.wakeAt,
    )
  }

  // ── How far a running work session reaches (RM-A12) ───────────────────────
  // Under `current-branch` every intent edits the SAME checkout, so one live
  // work session holds the gate shut for the whole workspace. Under `worktree`
  // each intent has its own directory: a live session then speaks only for its
  // own intent — it is still observed and never re-launched, but it no longer
  // stops another eligible intent from starting.
  const sharedCheckout = gitBranchMode !== 'worktree'

  // ── Something the kernel already drives → observe, never re-launch ────────
  const owned = candidates.find((r) => inFlight.has(r.id))
  if (owned && sharedCheckout) {
    pushDecision(owned, 'wait', 'running', '内核 run 进行中')
    for (const intent of candidates) {
      if (intent.id === owned.id || parkedThisPass.has(intent.id)) continue
      pushGateOrSpec(intent, gateOf.get(intent.id)!, '队列串行执行,等待当前意图结束')
    }
    return finish('developing', actions, decisions, {
      intentId: owned.id,
      sessionId: owned.lastWorkSessionId,
      awaitingPermission,
    })
  }

  // ── A live session the kernel does NOT own ────────────────────────────────
  // An eligible candidate whose own session is still running is attached to
  // (a run outlives its turn — never start a second one). Under a shared
  // checkout anything else that is alive holds the concurrency gate shut.
  const blocking = liveIntents[0]
  if (blocking && sharedCheckout) {
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
      pushGateOrSpec(
        intent,
        gateOf.get(intent.id)!,
        `全局并发闸门:「${blocking.title}」的工作会话仍在运行`,
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
        // Not a candidate at all, so it never takes a place in the line.
        queuePosition: null,
      })
    }
    return finish(attachable ? 'developing' : 'awaiting_gate', actions, decisions, {
      intentId: blocking.id,
      sessionId: blocking.lastWorkSessionId,
      awaitingPermission,
    })
  }

  // ── worktree mode: observe what already runs, then keep selecting ─────────
  // Each of these intents is being worked on in its OWN directory. They are
  // observed exactly as under a shared checkout — an in-flight kernel run is
  // waited on and a live session is attached to, never launched twice — but they
  // do not close the gate for anyone else.
  //
  // `busy` is this pass's anti-double-drive set: an intent in it is never picked.
  // `observed` is bookkeeping — it already holds a decision row for this pass.
  const busy = new Set<string>()
  const observed = new Set<string>()
  /** The intent this pass reports as the one the queue is currently driving. */
  let driving: QueueIntentFact | null = null
  if (!sharedCheckout) {
    for (const intent of candidates) {
      if (!inFlight.has(intent.id)) continue
      busy.add(intent.id)
      observed.add(intent.id)
      pushDecision(intent, 'wait', 'running', '内核 run 进行中')
      driving ??= intent
    }
    for (const live of liveIntents) {
      if (busy.has(live.id)) continue
      busy.add(live.id)
      const attachable =
        live.automate && gateOf.get(live.id)?.eligible === true && !parkedThisPass.has(live.id)
      if (!attachable || !live.lastWorkSessionId) continue
      actions.push({
        kind: 'attach',
        intentId: live.id,
        sessionId: live.lastWorkSessionId,
        origin: QUEUE_RUN_ORIGIN,
      })
      pushDecision(live, 'attach', 'attached_running', '会话仍在运行,挂接观察而非重复启动')
      observed.add(live.id)
      driving ??= live
    }
  }

  // ── Gate clear → select at most one intent ────────────────────────────────
  // Still ONE new work action per pass in either mode: worktree parallelism is
  // raised one intent per tick, not fanned out all at once.
  const picked = eligible.find((r) => !busy.has(r.id)) ?? null
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
    if (observed.has(intent.id)) continue
    pushGateOrSpec(
      intent,
      gateOf.get(intent.id)!,
      sharedCheckout
        ? '队列串行执行,等待前序意图结束'
        : '每轮最多发起一个新的工作动作,下一轮继续挑选',
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

  // Nothing new this pass, but work the queue drives is still running in its own
  // worktree — that is `developing`, not a gate the queue is waiting on.
  if (driving) {
    return finish('developing', actions, decisions, {
      intentId: driving.id,
      sessionId: driving.lastWorkSessionId,
      awaitingPermission,
    })
  }

  // A queue with recoverable, backing-off, parked or gated candidates is NOT
  // done — `done` means the snapshot holds no pending automation work at all.
  const stillPending = candidates.length > 0
  return finish(stillPending ? 'running' : 'done', actions, decisions, idle)
}

/**
 * Number the candidates this pass left waiting on the concurrency gate, so the
 * queue page can answer "how far away am I" instead of only "something else is
 * running".
 *
 * The order is the SELECTION order itself — `eligible` is already sorted by
 * priority then earliest creation — and only intents that cleared every gate yet
 * got no work action this pass are numbered, so position 1 is always the one the
 * next free slot goes to. Anything held by another gate, parked, force-skipped,
 * running, or merely waiting for the serial spec slot is absent from `eligible`
 * and keeps `null`; the numbers are therefore contiguous 1..N over exactly the
 * intents whose only remaining obstacle is the gate.
 */
function stampQueuePositions(
  decisions: QueueDecision[],
  eligible: readonly QueueIntentFact[],
): void {
  const order = new Map(eligible.map((r, i) => [r.id, i]))
  decisions
    .filter((d) => d.reason === 'blocked_concurrency_gate' && order.has(d.intentId))
    .sort((a, b) => order.get(a.intentId)! - order.get(b.intentId)!)
    .forEach((d, i) => {
      d.queuePosition = i + 1
    })
}

/**
 * Decide the spec phase for ONE intent that has not yet passed the spec gate.
 * Pure, and ordered so that every "something is already happening" case is
 * answered before anything is started — a live session, an in-flight kernel run
 * and the self-excitation cooldown all mean "wait", never "launch again".
 *
 * The progression, once nothing is in flight:
 *   status `raw`          → author it (no spec, or only the server's seed)
 *   spec unreadable       → wait (an unreadable spec is not an empty one)
 *   no valid conclusion   → review the current content
 *   changes_requested     → rework, until the cap, then hand it to a human
 *   pass                  → await human approval, or machine-approve under opt-in
 *
 * The status check comes FIRST, before the file's readability, its fingerprint or
 * any stored conclusion is looked at: `raw` means the document is still being
 * written, so a leftover fingerprint or verdict from an earlier life must not
 * start a review of it or report it as awaiting approval.
 *
 * "Valid conclusion" means the stored verdict was produced against the spec's
 * CURRENT fingerprint. That single comparison is what makes an edited spec
 * automatically re-reviewed, and what stops an approval resting on a document
 * that no longer exists — no invalidation pass, no clean-up job.
 */
function evaluateSpecPhase(
  intent: QueueIntentFact,
  ctx: {
    now: number
    meta: QueueIntentMeta
    alive: (sessionId: string | null) => boolean
    inFlight: boolean
    machineApprovalEnabled: boolean
  },
): SpecVerdict {
  const wait = (
    reason: QueueReasonCode,
    detail: string,
    wakeAt: number | null = null,
  ): SpecVerdict => ({ action: 'wait', reason, detail, actions: [], needsSlot: false, wakeAt })
  const block = (
    reason: QueueReasonCode,
    detail: string,
    wakeAt: number | null = null,
  ): SpecVerdict => ({ action: 'block', reason, detail, actions: [], needsSlot: false, wakeAt })

  // Something the kernel itself is already driving for this intent.
  if (ctx.inFlight) return wait('running', '规格阶段 run 进行中')
  if (ctx.alive(intent.specSessionId)) return wait('spec_authoring', '撰写会话运行中,等待其产出')
  if (ctx.alive(intent.specReviewSessionId)) {
    return wait('spec_review_running', '审核会话运行中,等待结论')
  }
  // The self-excitation guard: a tick and a lifecycle event arriving back-to-back
  // must not start two spec sessions for the same intent.
  if (ctx.meta.cooldownUntil !== null && ctx.meta.cooldownUntil > ctx.now) {
    return block('blocked_cooldown', '刚发起过一次规格阶段 run,冷却中', ctx.meta.cooldownUntil)
  }

  // `raw` — no spec at all, or only the seed the server wrote. Either way the
  // document is still being authored: it is NEVER reviewed (there is nothing to
  // judge) and never reported as awaiting approval. Nothing below this line is
  // reached for a `raw` intent, so no fingerprint, no leftover conclusion and no
  // machine-approval opt-in can pull a placeholder forward. The path back out is
  // the authoring run itself: whether it produced content is decided at the write
  // boundary, and only a persisted `pending` lets the reviewer start.
  if (intent.specStatus === 'raw') {
    return {
      action: 'launch_spec',
      reason: 'spec_authoring',
      detail: intent.specPath === null ? '尚无 spec,发起撰写会话' : 'spec 仍在撰写中,继续撰写会话',
      actions: [
        {
          kind: 'launch_spec',
          intentId: intent.id,
          origin: QUEUE_RUN_ORIGIN,
          rework: false,
          reworkRound: 0,
        },
      ],
      needsSlot: true,
      wakeAt: null,
    }
  }

  // Defensive: a status that says "authored" with no document is inconsistent —
  // fail closed and author it rather than reviewing a path that is not there.
  if (intent.specPath === null) {
    return {
      action: 'launch_spec',
      reason: 'spec_authoring',
      detail: '尚无 spec,发起撰写会话',
      actions: [
        {
          kind: 'launch_spec',
          intentId: intent.id,
          origin: QUEUE_RUN_ORIGIN,
          rework: false,
          reworkRound: 0,
        },
      ],
      needsSlot: true,
      wakeAt: null,
    }
  }

  // The ledger says a spec exists but its content could not be read. Fail closed:
  // reviewing "nothing" would be judging a document we never saw.
  if (intent.specFingerprint === null) {
    return block('spec_unreadable', 'spec 文件当前不可读,本轮不做审核')
  }

  const conclusionValid =
    intent.specReviewVerdict !== null && intent.specReviewFingerprint === intent.specFingerprint

  if (!conclusionValid) {
    return {
      action: 'launch_spec_review',
      reason: 'spec_reviewing',
      detail:
        intent.specReviewVerdict === null
          ? 'spec 已就绪但尚无审核结论,发起只读审核'
          : 'spec 内容已变更,旧结论失效,重新审核最新内容',
      actions: [
        {
          kind: 'launch_spec_review',
          intentId: intent.id,
          origin: QUEUE_RUN_ORIGIN,
          fingerprint: intent.specFingerprint,
        },
      ],
      needsSlot: true,
      wakeAt: null,
    }
  }

  if (intent.specReviewVerdict === 'changes_requested') {
    // `specReviewReworkRounds` counts `changes_requested` conclusions, and each
    // one launches exactly one rework. Rounds 1..CAP are reworked; the conclusion
    // AFTER the last allowed rework (round CAP+1) is where a human takes over.
    if (intent.specReviewReworkRounds > QUEUE_MAX_SPEC_REWORK) {
      const detail = `spec 已返工 ${QUEUE_MAX_SPEC_REWORK} 轮仍未通过审核,交回人工`
      return {
        action: 'park',
        reason: 'spec_rework_exhausted',
        detail,
        actions: [
          { kind: 'park', intentId: intent.id, reason: 'spec_rework_exhausted', detail },
          {
            kind: 'wait_user_involve',
            intentId: intent.id,
            reason: 'spec_rework_exhausted',
            detail,
          },
        ],
        needsSlot: false,
        wakeAt: null,
      }
    }
    return {
      action: 'launch_spec',
      reason: 'spec_rework',
      detail: `审核结论为需修改,发起第 ${intent.specReviewReworkRounds} 轮返工`,
      actions: [
        {
          kind: 'launch_spec',
          intentId: intent.id,
          origin: QUEUE_RUN_ORIGIN,
          rework: true,
          reworkRound: intent.specReviewReworkRounds,
        },
      ],
      needsSlot: true,
      wakeAt: null,
    }
  }

  // `pass`. Whether this becomes an approval is decided ONLY by the workspace's
  // explicit opt-in: with it off, no machine-approval action is produced at all,
  // so there is no path for one to be executed by mistake.
  if (!ctx.machineApprovalEnabled) {
    return block('spec_awaiting_approval', '审核通过,等待人工批准')
  }
  if (intent.specReviewMachineApprovalBlocked) {
    return block('spec_awaiting_approval', '人工已撤销该结论对应的批准,等待人工批准')
  }
  return {
    action: 'approve_spec',
    reason: 'spec_machine_approved',
    detail: '审核通过且工作区已开启机器批准,自动批准 spec',
    actions: [
      {
        kind: 'machine_approve_spec',
        intentId: intent.id,
        fingerprint: intent.specFingerprint,
      },
    ],
    needsSlot: false,
    wakeAt: null,
  }
}
