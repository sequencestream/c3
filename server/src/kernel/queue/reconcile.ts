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
 * Gate order is fixed and never relaxed: auto-recover (a failure-ladder park
 * whose every dependency is now satisfied → one `unpark` action, evaluated again
 * next pass) → park → force-skip → spec approval → delivery status → delivery
 * context → dependencies → backoff → cooldown, then the concurrency gate. A
 * parked intent is not `done`, so its downstream stays blocked by the dependency
 * gate exactly as before — parking isolates a failure, it never opens a path
 * around one, and an auto-recovery never relaxes a gate: the unparked intent is
 * simply re-evaluated from scratch next pass.
 *
 * The DEPENDENCY criterion is not stated here. It lives in `@ccc/shared`
 * ({@link evaluateDependencyGate}) and is shared verbatim with the manual launch
 * gate: the two used to hold different rules — the queue looked only at the
 * aggregate PR status, the manual gate also accepted "its branch is the
 * mainline" — and could therefore contradict each other on identical facts.
 * Everything the criterion needs is projected onto {@link QueueIntentFact} at the
 * assembly boundary, so this file stays a pure function.
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
  AUTO_RECOVERABLE_PARK_REASONS,
  QUEUE_MAX_SPEC_REWORK,
  QUEUE_PERMISSION_WAIT_MS,
  QUEUE_RUN_ORIGIN,
  QUEUE_TICK_MS,
  emptyQueueIntentMeta,
} from './types.js'
import {
  evaluateDependencyGate,
  findWriteBlockingDelivery,
  type DependencyGateFact,
  type DependencyGateVerdict,
} from '@ccc/shared'

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

  /** Project one ledger fact onto the shared criterion's dependency shape. */
  const toGateFact = (dep: QueueIntentFact): DependencyGateFact => ({
    id: dep.id,
    title: dep.title,
    status: dep.status,
    branchName: dep.branchName,
    deliveryIds: dep.deliveryIds,
    prStatusByDelivery: dep.prStatusByDelivery,
    prAggregate: dep.prStatus,
  })
  const gateFacts = intents.map(toGateFact)

  /**
   * The DELIVERY CONTEXT of an intent the queue would launch: its one
   * association, or none. `undefined` means "several" — the queue refuses to
   * choose (see `blocked_delivery_ambiguous`), so it never even evaluates the
   * dependency criterion under a context a human has not settled.
   */
  const deliveryContextOf = (intent: QueueIntentFact): string | null | undefined => {
    if (intent.deliveryIds.length === 0) return null
    if (intent.deliveryIds.length === 1) return intent.deliveryIds[0]
    return undefined
  }

  /** Run the ONE shared dependency criterion for this intent's context. */
  const dependencyVerdict = (
    intent: QueueIntentFact,
    sessionDeliveryId: string | null,
  ): DependencyGateVerdict =>
    evaluateDependencyGate({
      dependsOn: intent.dependsOn,
      dependencies: gateFacts,
      sessionDeliveryId,
      deliveries: input.deliveries,
      gitBranchMode,
      defaultMainBranch: input.defaultMainBranch,
    })

  /**
   * Whether every KNOWN dependency of an intent is satisfied, by exactly the
   * criterion the gate below applies — one function, so an auto-recovery can
   * never unpark an intent the very next gate would block again. An intent whose
   * delivery context is ambiguous is never considered satisfied: the queue cannot
   * evaluate it at all.
   */
  const depsSatisfied = (intent: QueueIntentFact): boolean => {
    const ctx = deliveryContextOf(intent)
    if (ctx === undefined) return false
    return !dependencyVerdict(intent, ctx).blocked
  }

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
    //
    // The ONE relaxation is per-intent `fast` mode, mirroring the manual
    // admission gate verbatim: a fast intent does not write its spec up front, so
    // waiting for an approved one would wedge it here forever and the queue would
    // disagree with the button on the same facts. It is only the spec gate that
    // opens — delivery writability, delivery ambiguity, dependencies, concurrency,
    // backoff and park all still apply below, and the spec phase never picks a
    // fast intent up (it only sees `blocked_spec_not_approved` ones), so
    // automation never authors a spec for it either.
    if (sddEnabled && intent.specStatus !== 'approved' && intent.effectiveSpecMode !== 'fast') {
      return {
        eligible: false,
        reason: 'blocked_spec_not_approved',
        detail: 'SDD 已开启但 spec 未批准',
        wakeAt: null,
      }
    }
    // Delivery status gate: a delivery being verified, already delivered or
    // cancelled takes no more code. Placed ahead of the dependency gate and
    // mirrored by the manual admission gate, so automation and the button cannot
    // disagree about who may write.
    const closedDelivery = findWriteBlockingDelivery(intent.deliveryIds, input.deliveries)
    if (closedDelivery) {
      return {
        eligible: false,
        reason: 'blocked_delivery_status',
        detail: `交付「${closedDelivery.title}」为 ${closedDelivery.status},不再接受新写入`,
        wakeAt: null,
      }
    }
    // Several deliveries → no determined baseline and no determined dependency
    // reading. The queue does not pick one: converging the associations (or
    // starting the session by hand with an explicit choice) is a human decision.
    const deliveryContext = deliveryContextOf(intent)
    if (deliveryContext === undefined) {
      return {
        eligible: false,
        reason: 'blocked_delivery_ambiguous',
        detail: `关联了 ${intent.deliveryIds.length} 个交付,需人工先收敛关联或手动选定后启动`,
        wakeAt: null,
      }
    }
    const verdict = dependencyVerdict(intent, deliveryContext)
    if (verdict.blocked) {
      const dep = verdict.dependency
      if (verdict.reason === 'not_done') {
        const status = byId.get(dep.id)?.status ?? 'unknown'
        return {
          eligible: false,
          reason: 'blocked_dependency',
          detail: `依赖「${dep.title}」尚未完成(${status})`,
          wakeAt: null,
        }
      }
      if (verdict.reason === 'delivery_not_delivered') {
        return {
          eligible: false,
          reason: 'blocked_dependency_delivery',
          detail: `依赖「${dep.title}」在交付「${verdict.delivery?.title ?? ''}」,该交付未合入主线`,
          wakeAt: null,
        }
      }
      return {
        eligible: false,
        reason: 'blocked_dependency_pr_unmerged',
        detail:
          verdict.reason === 'pr_unmerged'
            ? `依赖「${dep.title}」在交付「${verdict.delivery?.title ?? ''}」中的 PR 未确认合并`
            : `依赖「${dep.title}」的 PR 未确认合并`,
        wakeAt: null,
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

  // ── Auto-recover failure-ladder parks whose dependencies have cleared ──────
  // BEFORE the ordinary park gate answers `blocked_parked`: a candidate parked
  // by the consecutive-failure ladder whose every dependency is now satisfied is
  // a scheduling fact THIS pass acts on. It yields exactly one `unpark` action
  // and one `action='unpark'` decision, and is not evaluated further — the next
  // pass re-runs every gate from scratch. A dependency still outstanding keeps
  // `blocked_parked`; a park a human owns (permission wait, spec-rework cap,
  // human ruling) is never auto-recovered, whatever the dependencies say.
  const autoUnparked = new Set<string>()
  for (const intent of candidates) {
    const m = metaOf(intent.id)
    if (!m.parked || m.parkReason === null || !AUTO_RECOVERABLE_PARK_REASONS.has(m.parkReason)) {
      continue
    }
    if (!depsSatisfied(intent)) continue
    actions.push({ kind: 'unpark', intentId: intent.id })
    pushDecision(intent, 'unpark', 'auto_unpark', '失败阶梯类 park 的依赖已全部满足,自动解除 park')
    autoUnparked.add(intent.id)
  }

  const eligible: QueueIntentFact[] = []
  const gateOf = new Map<string, GateResult>()
  const unmergedDepIds = new Set<string>()
  for (const intent of candidates) {
    if (autoUnparked.has(intent.id)) continue
    const gate = evaluate(intent)
    gateOf.set(intent.id, gate)
    noteWake(gate.wakeAt)
    if (gate.eligible) eligible.push(intent)
    // A stale PR row is the commonest false block, so a PR-shaped block schedules
    // a refresh. `blocked_dependency_delivery` never does: a delivery's status is
    // a local ledger fact, and no forge call can change it.
    if (gate.reason === 'blocked_dependency_pr_unmerged') {
      const ctx = deliveryContextOf(intent) ?? null
      for (const depId of intent.dependsOn) {
        const dep = byId.get(depId)
        if (!dep || dep.status !== 'done') continue
        const prStatus =
          ctx !== null && dep.deliveryIds.includes(ctx)
            ? (dep.prStatusByDelivery[ctx] ?? null)
            : dep.prStatus
        if (prStatus !== 'merged') unmergedDepIds.add(dep.id)
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
      if (intent.id === owned.id || parkedThisPass.has(intent.id) || autoUnparked.has(intent.id)) {
        continue
      }
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
      if (
        intent.id === blocking.id ||
        parkedThisPass.has(intent.id) ||
        autoUnparked.has(intent.id)
      ) {
        continue
      }
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
  // `occupied` is the concurrent-dev count for the automation cap: in-flight
  // kernel runs plus every AUTOMATE live session (a manual session in its own
  // worktree is not queue-driven and does not consume a slot). Deduped with the
  // anti-double-drive set, so the same intent in several facts counts once.
  const busy = new Set<string>()
  const observed = new Set<string>()
  const occupied = new Set<string>()
  /** The intent this pass reports as the one the queue is currently driving. */
  let driving: QueueIntentFact | null = null
  if (!sharedCheckout) {
    for (const intent of candidates) {
      if (!inFlight.has(intent.id)) continue
      busy.add(intent.id)
      occupied.add(intent.id)
      observed.add(intent.id)
      pushDecision(intent, 'wait', 'running', '内核 run 进行中')
      driving ??= intent
    }
    for (const live of liveIntents) {
      if (busy.has(live.id)) continue
      busy.add(live.id)
      if (live.automate) occupied.add(live.id)
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

  // ── Automation concurrency cap (RM-A12 scope) ─────────────────────────────
  // `current-branch` shares ONE checkout, so the effective cap is always 1 and
  // the config is ignored — the serial branches above already enforce that.
  // `worktree` grants each intent its own directory, so the queue may develop up
  // to `automationConcurrency` intents at once. At/over the cap the queue stops
  // launching and blocks every remaining eligible candidate behind
  // `blocked_concurrency_gate`; lowering the cap never cancels in-flight runs,
  // it only freezes new auto-dispatch until occupancy drops below it.
  const effectiveCap = sharedCheckout ? 1 : input.automationConcurrency
  const capReached = occupied.size >= effectiveCap

  // ── Gate clear → select at most one intent ────────────────────────────────
  // Still ONE new work action per pass in either mode: worktree parallelism is
  // raised one intent per tick, not fanned out all at once. The cap is checked
  // before picking, so a pick can never push occupancy past it (a pick adds at
  // most one slot).
  const picked = capReached ? null : (eligible.find((r) => !busy.has(r.id)) ?? null)
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
    if (parkedThisPass.has(intent.id) || autoUnparked.has(intent.id)) continue
    if (observed.has(intent.id)) continue
    pushGateOrSpec(
      intent,
      gateOf.get(intent.id)!,
      sharedCheckout
        ? '队列串行执行,等待前序意图结束'
        : capReached
          ? `已达并发上限 ${effectiveCap}`
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
