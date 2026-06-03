/**
 * Automation orchestrator — a per-project background loop that develops
 * `automate` requirements one at a time, by priority then dependency order,
 * fully unattended.
 *
 * For each eligible requirement it:
 *   1. launches a dev run (the configurable development skill; via the injected {@link AutomationHooks.runDevTurn});
 *   2. on a normal turn end, judges true completion from the agent's last message
 *      + the working-tree diff ({@link judgeCompletion});
 *   3. if done → commit & push → mark `done` → next requirement;
 *      if in_progress → resume with continue (capped, to clear dev-skill checkpoints);
 *      if stuck / the run errored / it blocked on a permission / push failed →
 *      stop the whole loop and record the reason on the status (shown next to the
 *      automation button).
 *
 * Eligibility: `automate` AND status ∈ {todo, in_progress} AND every dependency
 * is `done`. Sorted P0→P3 then oldest-first. If the requirement's linked dev
 * session is ALREADY running a turn (a run outlives its turn), the orchestrator
 * ATTACHES to that in-flight turn instead of starting another (no double-run /
 * preempt). Otherwise an `in_progress` requirement whose `lastDevSessionId` still
 * exists on disk is RESUMED (its half-built context is continued); a `todo` or
 * dangling one starts a fresh dev session (matching the existing dangling-restart
 * behaviour).
 *
 * One controller per project (module-level map). State survives connection churn
 * like every other runtime; it does NOT survive a server restart (in-memory).
 */
import type { AutomationStatus, Requirement, ServerToClient } from '@ccc/shared/protocol'
import { getRequirement, listRequirements, setLastDevSession, updateStatus } from './store.js'
import { judgeCompletion } from './judge.js'
import { commitAndPush, gitDiffStat, gitRecentLog } from '../git.js'
import { getDevSkill } from '../settings.js'

/** Outcome of one dev turn, as observed by the orchestrator's internal viewer. */
export interface DevTurnResult {
  /**
   * - `complete` — the turn ended normally (`turn_end: complete`); judge it.
   * - `error` — the turn ended with an error (`turn_end: error`).
   * - `blocked` — the run was aborted (automation stopped, or a teardown).
   *
   * NOTE: a permission prompt no longer yields `blocked`. Automation mirrors
   * manual execution — a prompt keeps the run alive and is surfaced to the
   * browser for the watching human to answer (see {@link RunDevTurnInput.onAwaitingPermission});
   * the turn then settles `complete`/`error` once the human responds.
   */
  outcome: 'complete' | 'error' | 'blocked'
  /** The dev session id (real, after binding). */
  sessionId: string
  /** The agent's last assistant text this turn (for the completion judge). */
  lastMessage: string
  /** Error message (`error`) or blocking tool name / 'aborted' (`blocked`). */
  detail?: string
  /**
   * The turn ended on an UNANSWERED human-decision point — an `AskUserQuestion`
   * permission request that was never resolved. A live AskUserQuestion settles the
   * turn as `blocked` (the viewer aborts the run), but on the attach buffer-replay
   * path a settled run with a pending question can surface as `complete`; this flag
   * lets {@link AutomationController.develop} force a stop even if the completion
   * judge mis-reads it as `in_progress` — a real decision must not be continue-ed away.
   */
  pendingQuestion?: boolean
}

export interface RunDevTurnInput {
  projectPath: string
  /** null ⇒ start a fresh session; a real id ⇒ resume it (continuation). */
  sessionId: string | null
  prompt: string
  requirementId: string
  signal: AbortSignal
  /**
   * `true` ⇒ the session (`sessionId`) is already running a turn in the
   * background; do NOT launch or push — only attach an internal viewer and track
   * that in-flight turn until it settles. `prompt` is ignored in this mode.
   */
  attach?: boolean
  /**
   * Called as soon as the run binds its real SDK session id (early — well before
   * the turn ends), so the orchestrator can flip the requirement to `in_progress`
   * and link the dev session immediately, mirroring manual `start_development`.
   * Only fires for a fresh launch (a resumed/continuation turn already has its id).
   */
  onSessionId?: (sessionId: string) => void
  /**
   * Called when the in-flight turn pauses on / resumes from a permission prompt
   * (`true` ⇒ now awaiting a human answer, `false` ⇒ answered / settled). Lets the
   * orchestrator surface an "awaiting authorization" hint on the automation status
   * while a watching human answers the prompt in the browser.
   */
  onAwaitingPermission?: (awaiting: boolean) => void
}

/** Server-provided integration points (everything tied to the WS-server closure). */
export interface AutomationHooks {
  /** Launch (or resume) a dev run and resolve once the turn settles. */
  runDevTurn(input: RunDevTurnInput): Promise<DevTurnResult>
  /** Push the project's updated requirement list to all connections. */
  broadcastRequirements(projectPath: string): void
  /** Push an automation status to all connections. */
  emitStatus(status: AutomationStatus): void
  /**
   * Whether a dev session still exists on disk — so a resumable `lastDevSessionId`
   * is continued and a dangling one falls back to a fresh launch, exactly like
   * manual `start_development`'s dangling check.
   */
  sessionExists(projectPath: string, sessionId: string): Promise<boolean>
  /**
   * Whether a session currently has a turn executing in the background (a run
   * outlives the turn — a session isn't "done" when its run settles). When true
   * for a requirement's `lastDevSessionId`, the orchestrator ATTACHES to that
   * in-flight turn instead of launching a second one (which would double-run /
   * preempt it).
   */
  isRunning(sessionId: string): boolean
}

/** Max continue resumes per requirement before giving up (clears dev-skill checkpoints). */
const MAX_CONTINUATIONS = 10

/**
 * Does a runtime buffer end on an UNANSWERED `AskUserQuestion` — a real human
 * decision point left open? An answered question gets a `tool_result` echoed back
 * with the same `toolUseId`; an unanswered one (the run was killed / nobody
 * replied) has the `tool_use` but no matching `tool_result`. Used as a guard
 * independent of the completion judge: a turn that surfaced via the attach
 * buffer-replay path can read as `complete` while still carrying a pending
 * question, and a blind continue must NOT be sent to answer it (see RM-A11).
 *
 * Pure (buffer in, boolean out) so the orchestrator's defence is unit-testable
 * without standing up a runtime.
 */
export function hasPendingQuestion(buffer: readonly ServerToClient[]): boolean {
  const answered = new Set<string>()
  for (const e of buffer) {
    if (e.type === 'tool_result') answered.add(e.toolUseId)
  }
  for (const e of buffer) {
    if (e.type === 'tool_use' && e.toolName === 'AskUserQuestion' && !answered.has(e.toolUseId)) {
      return true
    }
  }
  return false
}

function idleStatus(projectPath: string): AutomationStatus {
  return {
    projectPath,
    state: 'idle',
    currentRequirementId: null,
    currentSessionId: null,
    awaitingPermission: false,
    error: null,
    completedIds: [],
    startedAt: null,
  }
}

/** Eligible requirements, best candidate first; null when none remain. */
function pickNext(projectPath: string): Requirement | null {
  const all = listRequirements(projectPath)
  const byId = new Map(all.map((r) => [r.id, r]))
  const eligible = all.filter(
    (r) =>
      r.automate &&
      (r.status === 'todo' || r.status === 'in_progress') &&
      r.dependsOn.every((id) => {
        const dep = byId.get(id)
        // Unknown dep (cross-project / deleted) doesn't block; known dep must be done.
        return !dep || dep.status === 'done'
      }),
  )
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 } as const
  eligible.sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt - b.createdAt)
  return eligible[0] ?? null
}

class AutomationController {
  readonly status: AutomationStatus
  private readonly abort = new AbortController()

  constructor(
    private readonly projectPath: string,
    private readonly hooks: AutomationHooks,
    startedAt: number,
  ) {
    this.status = {
      ...idleStatus(projectPath),
      state: 'running',
      startedAt,
    }
  }

  stop(): void {
    this.abort.abort()
  }

  private emit(): void {
    // Send a copy so later mutations don't race the serialized wire payload.
    this.hooks.emitStatus({ ...this.status, completedIds: [...this.status.completedIds] })
  }

  /** Reflect "awaiting human authorization" on the status (no-op if unchanged). */
  private setAwaiting(awaiting: boolean): void {
    if (this.status.awaitingPermission === awaiting) return
    this.status.awaitingPermission = awaiting
    this.emit()
  }

  /** Link the dev session + flip the requirement to in_progress, then broadcast. */
  private markInProgress(reqId: string, sessionId: string): void {
    setLastDevSession(reqId, sessionId)
    if (getRequirement(reqId)?.status !== 'in_progress') updateStatus(reqId, 'in_progress')
    this.status.currentSessionId = sessionId
    this.hooks.broadcastRequirements(this.projectPath)
    this.emit()
  }

  private fail(reason: string): void {
    console.warn(`[c3:automation] 停止 (${this.projectPath}): ${reason}`)
    this.status.state = 'error'
    this.status.error = reason
    this.status.currentRequirementId = null
    this.status.currentSessionId = null
    this.emit()
  }

  /**
   * RM-A12: Global concurrency gate. Before picking the next eligible
   * requirement, check whether ANY in_progress requirement (including
   * non-automate manual runs) has a dev session that is truly running
   * (isRunning returns true). If so, attach an internal viewer and wait
   * for the current turn to settle before proceeding.
   * Dangling sessions (exists on disk but not running) do NOT block.
   *
   * Returns true to continue the loop, false if the loop must stop (the
   * caller should check abort and return).
   */
  private async awaitProjectRunning(): Promise<boolean> {
    const all = listRequirements(this.projectPath)
    const running = all.find(
      (r) =>
        r.status === 'in_progress' &&
        !!r.lastDevSessionId &&
        this.hooks.isRunning(r.lastDevSessionId),
    )
    if (!running) return true // gate clear

    console.log(
      `[c3:automation] 全局并发闸门:「${running.title}」的 dev session 仍在运行,等待 turn settle`,
    )

    // Track which requirement we're waiting on for status display.
    this.status.currentRequirementId = running.id
    this.status.currentSessionId = running.lastDevSessionId!
    this.emit()

    const turn = await this.hooks.runDevTurn({
      projectPath: this.projectPath,
      sessionId: running.lastDevSessionId!,
      prompt: '', // ignored when attach=true
      requirementId: running.id,
      signal: this.abort.signal,
      attach: true,
      onAwaitingPermission: (awaiting) => this.setAwaiting(awaiting),
    })
    this.setAwaiting(false)

    if (this.abort.signal.aborted) return false

    // A non-automate requirement that errored or blocked on a permission:
    // log the event but do NOT stop the orchestrator — the gate only waits;
    // the manual requirement's lifecycle is outside our scope.
    if (turn.outcome !== 'complete') {
      console.warn(
        `[c3:automation] gate: "${running.title}" turn ended (outcome=${turn.outcome}); non-automate requirement, continuing`,
      )
    }

    // Loop back to re-check the gate (another requirement may have started
    // running during our wait).
    return true
  }

  /** The main loop. Runs detached; resolves when the loop ends (done/error/stop). */
  async run(): Promise<void> {
    this.emit()
    while (!this.abort.signal.aborted) {
      // RM-A12: Global concurrency gate — wait for any in_progress requirement
      // (including non-automate manual runs) with a truly running dev session
      // to settle before picking the next automate requirement.
      if (!(await this.awaitProjectRunning())) {
        if (this.abort.signal.aborted) {
          this.status.state = 'idle'
          this.status.currentRequirementId = null
          this.status.currentSessionId = null
          this.emit()
        }
        return
      }

      const req = pickNext(this.projectPath)
      if (!req) {
        this.status.state = 'done'
        this.status.currentRequirementId = null
        this.status.currentSessionId = null
        this.emit()
        return
      }
      this.status.currentRequirementId = req.id
      this.status.currentSessionId = null
      this.emit()

      const ok = await this.develop(req)
      if (this.abort.signal.aborted) {
        // Stopped by the user mid-requirement: go quiet (idle), keep no error.
        this.status.state = 'idle'
        this.status.currentRequirementId = null
        this.status.currentSessionId = null
        this.emit()
        return
      }
      if (!ok) return // develop() already set the error state + emitted
    }
    // Aborted before picking anything.
    this.status.state = 'idle'
    this.emit()
  }

  /**
   * Develop one requirement to a terminal state. Returns true if it was committed
   * (move to the next), false if the loop must stop (error already recorded).
   */
  private async develop(req: Requirement): Promise<boolean> {
    // If the requirement's linked dev session is ALREADY running a turn in the
    // background, don't launch/push a second one (that would double-run / preempt
    // it) — attach to it and track until it settles, then judge. A run outlives
    // its turn, so a session that's still running here is the common re-start case.
    let attach = !!req.lastDevSessionId && this.hooks.isRunning(req.lastDevSessionId!)
    // Otherwise resume the requirement's existing dev session when it's still on
    // disk (continue the half-built context with continue); a `todo` item or a dangling
    // session (empty/deleted `lastDevSessionId`) starts a fresh launch — the same
    // dangling rule as manual `start_development`.
    const resumable =
      !attach &&
      req.status === 'in_progress' &&
      !!req.lastDevSessionId &&
      (await this.hooks.sessionExists(this.projectPath, req.lastDevSessionId))
    let sessionId: string | null = attach || resumable ? req.lastDevSessionId : null
    let continuations = 0
    while (!this.abort.signal.aborted) {
      const skill = getDevSkill()
      const skillPrefix = skill ? `${skill} ` : ''
      const prompt =
        sessionId === null
          ? `${skillPrefix}${req.title}\n\n${req.content}${
              req.dependsOn.length ? `\n\n依赖需求:${req.dependsOn.join(', ')}` : ''
            }`
          : 'continue'
      // When attaching, there's no launch to fire `onSessionId`, so mark in_progress
      // up front: the status must reflect "tracking <session>" (currentSessionId set)
      // while the in-flight turn runs, not only after it settles.
      if (attach && sessionId) this.markInProgress(req.id, sessionId)
      const turn = await this.hooks.runDevTurn({
        projectPath: this.projectPath,
        sessionId,
        prompt,
        requirementId: req.id,
        signal: this.abort.signal,
        attach,
        // Flip to in_progress + link the dev session AS SOON AS it binds (early,
        // well before the turn ends) — exactly like manual start_development.
        onSessionId: (sid) => this.markInProgress(req.id, sid),
        // Surface "awaiting authorization" while the turn pauses on a permission
        // prompt (automation now waits for the watching human, like manual).
        onAwaitingPermission: (awaiting) => this.setAwaiting(awaiting),
      })
      // The turn has settled — it is no longer paused on any prompt.
      this.setAwaiting(false)
      // Only the first turn attaches; the attached turn settles the run, so any
      // continue continuation goes through the ordinary resume path.
      attach = false
      if (this.abort.signal.aborted) return false

      // Fallback: if the early bind never fired (a resumed turn, or an error before
      // binding), still record the session id and keep the status consistent.
      if (this.status.currentSessionId !== turn.sessionId) {
        this.markInProgress(req.id, turn.sessionId)
      }
      sessionId = turn.sessionId

      if (turn.outcome === 'error') {
        this.fail(`「${req.title}」运行出错:${turn.detail ?? '未知错误'}`)
        return false
      }
      if (turn.outcome === 'blocked') {
        this.fail(
          turn.detail === 'aborted'
            ? '自动化已停止'
            : `「${req.title}」需要人工授权:${turn.detail ?? '权限请求'}`,
        )
        return false
      }

      // Normal turn end → judge true completion. Evidence includes BOTH the
      // uncommitted diff and recent commits, since the dev skill may self-commit
      // (leaving the tree clean) — an empty diff alone must not read as "未完成".
      const [diffStat, recentLog] = await Promise.all([
        gitDiffStat(this.projectPath),
        gitRecentLog(this.projectPath),
      ])
      const verdict = await judgeCompletion({
        req,
        lastMessages: [turn.lastMessage],
        evidence: { diffStat, recentLog },
        cwd: this.projectPath,
        signal: this.abort.signal,
      })
      if (this.abort.signal.aborted) return false

      // Defence in depth (independent of the judge): if the turn ended on an
      // unanswered AskUserQuestion, a real human decision is pending — never let a
      // mis-judged `in_progress` drive a blind continue over it. Force a stop with a
      // recorded reason, exactly like the stuck / cap paths below.
      if (turn.pendingQuestion) {
        this.fail(`「${req.title}」需要人工决策(未作答的提问):${verdict.reason}`)
        return false
      }

      if (verdict.verdict === 'done') {
        const res = await this.commitWithLintHeal(req, sessionId)
        if (this.abort.signal.aborted) return false
        if (!res.ok) {
          this.fail(`「${req.title}」${res.error ?? '提交失败'}`)
          return false
        }
        updateStatus(req.id, 'done')
        this.status.completedIds.push(req.id)
        this.hooks.broadcastRequirements(this.projectPath)
        console.log(
          `[c3:automation]「${req.title}」已完成 → done${res.committed ? ' (已提交)' : ''} (已推送)`,
        )
        return true
      }
      if (verdict.verdict === 'in_progress') {
        continuations += 1
        if (continuations > MAX_CONTINUATIONS) {
          this.fail(
            `「${req.title}」超过最大续跑次数(${MAX_CONTINUATIONS}),最后状态:${verdict.reason}`,
          )
          return false
        }
        continue // resume with continue
      }
      // stuck
      this.fail(`「${req.title}」未真实完成:${verdict.reason}`)
      return false
    }
    return false
  }

  /**
   * RM-A13: commit & push the finished work, self-healing a pre-commit **lint**
   * failure by handing it to the dev agent **once**.
   *
   * Lint toolchains differ per project (language/framework), so there is no
   * portable fix *command* — when the commit is rejected by a pre-commit lint
   * hook (`commitAndPush` returns `failure: 'commit-hook'`), the orchestrator
   * resumes the **same** dev session with a targeted prompt carrying the lint
   * error summary and lets the agent fix it, then retries the commit **exactly
   * once**. A first commit that fails with `failure !== 'commit-hook'` (push
   * rejected, no upstream, conflict-state, no repo …) is returned verbatim — it
   * is NOT a lint failure and must surface as a hard stop (RM-A6), never silently
   * retried. If the single agent retry's commit still fails (lint or otherwise),
   * the error is surfaced and the loop stops (RM-A6, requirement not `done`).
   *
   * Every stage logs a visible trail. Returns `{ ok:false }` with no error on
   * abort — the caller checks the signal and returns quietly.
   */
  private async commitWithLintHeal(
    req: Requirement,
    sessionId: string,
  ): Promise<{ ok: boolean; committed?: boolean; error?: string }> {
    const message = `feat: ${req.title}`
    let res = await commitAndPush(this.projectPath, message)
    if (res.ok) return { ok: true, committed: res.committed }
    // Not a lint/pre-commit-hook failure → never self-heal; surface as a hard stop.
    if (res.failure !== 'commit-hook') return { ok: false, error: res.error }

    if (this.abort.signal.aborted) return { ok: false }
    // Single agent attempt: resume the dev session to fix what the lint hook rejected.
    console.warn(
      `[c3:automation]「${req.title}」pre-commit lint 失败,启动修复 agent 介入一次:${res.error}`,
    )
    const fixPrompt = `pre-commit 钩子的 lint 检查未通过,本次提交被拦截。请修复以下 lint/格式报错,改完即可,无需自行 git commit:\n\n${res.error ?? 'pre-commit lint 失败'}`
    const turn = await this.hooks.runDevTurn({
      projectPath: this.projectPath,
      sessionId,
      prompt: fixPrompt,
      requirementId: req.id,
      signal: this.abort.signal,
      onAwaitingPermission: (awaiting) => this.setAwaiting(awaiting),
    })
    this.setAwaiting(false)
    if (this.abort.signal.aborted) return { ok: false }
    if (turn.outcome !== 'complete') {
      console.warn(
        `[c3:automation] 修复 agent turn 未正常结束 (outcome=${turn.outcome});仍尝试重试 commit`,
      )
    }

    res = await commitAndPush(this.projectPath, message)
    if (res.ok) return { ok: true, committed: res.committed }
    // The single retry still failed — stop and surface the reason (RM-A6).
    return {
      ok: false,
      error:
        res.failure === 'commit-hook'
          ? `lint 自动修复失败(修复 agent 介入后仍未通过):${res.error ?? '未知 lint 错误'}`
          : res.error,
    }
  }
}

const controllers = new Map<string, AutomationController>()

/** Current status for a project (idle when never started). */
export function getAutomationStatus(projectPath: string): AutomationStatus {
  return controllers.get(projectPath)?.status ?? idleStatus(projectPath)
}

/**
 * Start the orchestrator for a project. No-op (returns the live status) if one is
 * already running. Otherwise starts a fresh loop detached and returns its initial
 * status; progress arrives via {@link AutomationHooks.emitStatus}.
 */
export function startAutomation(
  projectPath: string,
  hooks: AutomationHooks,
  now: number,
): AutomationStatus {
  const existing = controllers.get(projectPath)
  if (existing && existing.status.state === 'running') return existing.status
  const controller = new AutomationController(projectPath, hooks, now)
  controllers.set(projectPath, controller)
  // Detached: the loop runs in the background and reports via emitStatus.
  void controller.run().catch((err) => {
    controller.status.state = 'error'
    controller.status.error = `自动化进程异常:${err instanceof Error ? err.message : String(err)}`
    hooks.emitStatus({ ...controller.status })
  })
  return controller.status
}

/** Stop the orchestrator for a project (aborts the current dev run). */
export function stopAutomation(projectPath: string): AutomationStatus {
  controllers.get(projectPath)?.stop()
  return getAutomationStatus(projectPath)
}
