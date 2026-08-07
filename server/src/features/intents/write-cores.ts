/**
 * Framing-free cores for the two intent WRITES that reach outside c3 — creating
 * a PR and changing an intent's status.
 *
 * They were extracted from the WebSocket handlers verbatim so a second surface
 * (the advisor MCP tool group) executes the SAME gates in the SAME order instead
 * of re-implementing them. The rule the extraction protects: an action an agent
 * can take must have a human equivalent, and both must run one gate chain — not
 * two that drift.
 *
 * Neither function sends on a connection. Each returns a structured result the
 * caller frames as a WS `error` / response or as an MCP `{content, isError}`.
 */
import type {
  CreatePrStage,
  GitActionFailureGuidance,
  Intent,
  IntentStatus,
} from '@ccc/shared/protocol'
import { CREATE_PR_STAGES } from '@ccc/shared/protocol'
import { closeForgePr, commitAndPush, createForgePr, hasDiffAgainstBase } from '../../git.js'
import {
  getDefaultMainBranch,
  getForgeOverride,
  getGitBranchMode,
} from '../../kernel/config/index.js'
import { getDelivery } from '../deliveries/store.js'
import { pathToId } from '../../state.js'
import { runServerSidePrCreate } from '../pr-events/tool-defs.js'
import type { GenericEvent } from '@ccc/shared'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'
import { normalizeBranchName } from './dependency-gate.js'
import { buildGitFailureGuidance } from './git-failure.js'
import type { GitFailureStage } from './git-failure.js'
import { publishIntentStatusTransition } from './lifecycle-events.js'
import { clearJudgedSession, clearRunStatus } from './run-status.js'
import { activeIntentPrs } from '@ccc/shared'
import {
  canTransition,
  getIntent,
  isStoreAvailable,
  safeInsertIntentLog,
  updateStatus,
  upsertIntentPr,
} from './store.js'
import { parsePrIdentity } from './pr-identity.js'
import { getWorktreePath } from './worktree.js'

/** A structured outcome both surfaces can frame. */
export type IntentWriteResult<T = Record<string, never>> =
  | ({ success: true } & T)
  | {
      success: false
      code: string
      params?: Record<string, string>
      /**
       * Targeted repair guidance for a failed Git / forge command. Set only on
       * the commit → push → create chain, never on a gate rejection (which keeps
       * its own precise copy) and never on the `prId` idempotency guard (nothing
       * ran, so there is nothing to classify or retry).
       */
      guidance?: GitActionFailureGuidance
    }

// ---------------------------------------------------------------------------
// create_pr
// ---------------------------------------------------------------------------

export interface CreatePrDeps {
  broadcastIntents: (workspacePath: string) => void
  /** Normalize an untrusted event core through the kernel normalizer registry. */
  normalizeEvent: (core: GenericEvent) => NormalizeResult
  /** Publish the normalized `pr:create` event so event-triggered automations react. */
  publishEvent: (workspacePath: string, sessionId: string, event: GenericEvent) => void
  /** Lifecycle-log actor. */
  actor?: string | null
  /**
   * Optional coarse progress sink for a user-initiated run (the WS handler pushes
   * it to the requesting connection). Omitted by the agent/automation surfaces,
   * which have no connection to report to. Observational only — it never changes
   * a gate, a Git action or the returned result.
   */
  onStage?: (stage: CreatePrStage) => void
}

/**
 * Where one create_pr run points: the delivery it belongs to (`null` = no
 * delivery binding, the pre-delivery mainline behaviour) and the branch its PR
 * is opened against. Resolved ONCE per run and threaded through the diff gate,
 * the forge create, the ledger row and the `pr:create` event.
 */
type PrTargetResolution =
  { ok: true; deliveryId: string | null; baseBranch: string } | { ok: false; code: string }

/**
 * Resolve which delivery this create targets, and the base branch that follows
 * from it.
 *
 * An explicit `deliveryId` wins. Without one, the intent's association edges
 * decide: none → the mainline (a workspace that never adopted deliveries keeps
 * working exactly as before), exactly one → that delivery, several → refused.
 * "Several" is the one case where a choice exists and only the user can make it;
 * picking the first edge would silently file the PR against a delivery the user
 * never chose. The same resolution serves the human and the advisor entry points,
 * so an agent cannot reach a target a human could not.
 *
 * A named delivery must exist, belong to THIS workspace, and already be linked
 * to the intent — the link check keeps `intent_prs.delivery_id` from pointing at
 * a delivery `intent_deliveries` knows nothing about, which would file the PR row
 * under a group the intent detail never renders. Only then does branch readiness
 * apply, so an unusable id never surfaces as "branch not ready".
 */
function resolvePrTarget(
  workspacePath: string,
  intent: Intent,
  requestedDeliveryId: string | undefined,
): PrTargetResolution {
  const linked = intent.linkedDeliveries
  let deliveryId: string | null
  if (requestedDeliveryId) {
    deliveryId = requestedDeliveryId
  } else if (linked.length === 0) {
    deliveryId = null
  } else if (linked.length === 1) {
    deliveryId = linked[0].id
  } else {
    return { ok: false, code: 'delivery.prCreateAmbiguous' }
  }

  if (deliveryId === null) {
    return { ok: true, deliveryId: null, baseBranch: getDefaultMainBranch(workspacePath) ?? 'main' }
  }

  const delivery = getDelivery(deliveryId)
  if (!delivery || delivery.workspaceId !== pathToId(workspacePath)) {
    return { ok: false, code: 'delivery.prCreateDeliveryUnknown' }
  }
  if (!linked.some((d) => d.id === deliveryId)) {
    return { ok: false, code: 'delivery.prCreateNotLinked' }
  }
  const branchName = normalizeBranchName(delivery.branchName)
  if (!delivery.branchReady || branchName === null) {
    return { ok: false, code: 'delivery.guard.branchNotReady' }
  }
  return { ok: true, deliveryId, baseBranch: branchName }
}

/**
 * Wrap `onStage` so stages are reported at most once and only ever forward.
 * `commitAndPush` fires its commit/push boundary once per affected repo in a
 * multi-repo workspace; the overlay contract is a single one-way pass, so the
 * repeats and the resulting back-steps are dropped here rather than on the wire.
 */
function monotonicStageReporter(
  onStage: ((stage: CreatePrStage) => void) | undefined,
): (stage: CreatePrStage) => void {
  let reached = -1
  return (stage) => {
    if (!onStage) return
    const index = CREATE_PR_STAGES.indexOf(stage)
    if (index <= reached) return
    reached = index
    onStage(stage)
  }
}

/**
 * Create a PR for one intent, toward one delivery target. Gate order is fixed:
 * worktree mode → non-empty branch → the target resolves (delivery exists in
 * this workspace, is linked, and its branch is ready) → that target has no
 * active PR yet (idempotent, no Git work at all) → the worktree actually differs
 * from the target's base. Only then does it commit, push, and create the PR; a
 * failed commit never creates one.
 *
 * The idempotency key is the PAIR `(intentId, deliveryId)`, matching the ledger's
 * unique index — not "the intent has any active PR". An intent legitimately owns
 * one PR per delivery, so the same head branch can back a second PR row toward a
 * different delivery; only a repeat of the SAME pair is refused. `merged` /
 * `closed` rows never block: that PR's life is over.
 *
 * The effective base is resolved ONCE — the delivery's branch when the run
 * targets one, the workspace's `defaultMainBranch` (explicit `main` when unset)
 * when it does not — and threaded through the diff gate, the forge create, the
 * ledger row and the `pr:create` event; no layer re-derives or defaults it. The
 * diff gate prefers the freshly-fetched remote base; when the base resolves
 * neither remotely nor locally it rejects with a readable detail (before any
 * commit/push/forge work) instead of passing through — which is also what
 * catches a delivery branch deleted after it was marked ready.
 *
 * `deps.onStage` observes that same order: the synchronous gates ahead of the
 * diff check report nothing (a rejection there is only an error), and a failure
 * never reports a stage the run did not reach.
 */
export async function createPrForIntent(
  workspacePath: string,
  intentId: string,
  deps: CreatePrDeps,
  requestedDeliveryId?: string,
): Promise<IntentWriteResult<{ prId: string; prUrl: string }>> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }
  const req = getIntent(intentId)
  if (!req) return { success: false, code: 'intent.notFound' }

  if (getGitBranchMode(workspacePath) !== 'worktree') {
    return { success: false, code: 'intent.prCreateNotWorktree' }
  }
  if (normalizeBranchName(req.branchName) === null) {
    return { success: false, code: 'intent.prCreateNoBranch' }
  }

  // Target resolution before the idempotency guard: "which delivery" decides
  // WHICH active PR would collide, so an unresolvable target must fail with its
  // own readable reason rather than borrow another pair's collision.
  const target = resolvePrTarget(workspacePath, req, requestedDeliveryId)
  if (!target.ok) return { success: false, code: target.code }
  const { deliveryId, baseBranch } = target

  // Idempotent guard on the resolved pair: a target that already carries a live
  // PR is never re-created — no Git checks, no commit, no push. Independent of
  // intent status, and blind to other pairs' PRs.
  const conflict = activeIntentPrs(req.prs).find((pr) => pr.deliveryId === deliveryId)
  if (conflict) {
    return {
      success: false,
      code: 'intent.prCreateFailed',
      params: { detail: `intent 已有 PR #${conflict.number}` },
    }
  }

  const providerOverride = getForgeOverride(workspacePath)

  const reportStage = monotonicStageReporter(deps.onStage)
  const worktreePath = getWorktreePath(workspacePath, intentId)
  reportStage('analyzing-changes')
  let hasDiff: boolean
  try {
    hasDiff = await hasDiffAgainstBase(worktreePath, baseBranch)
  } catch (err) {
    // Target branch unresolvable → reject with a readable detail rather than
    // the old pass-through. Nothing has been committed, pushed or created.
    const detail = err instanceof Error ? err.message : String(err)
    return { success: false, code: 'intent.prCreateFailed', params: { detail } }
  }
  if (!hasDiff) {
    return { success: false, code: 'intent.prCreateNoChanges' }
  }

  const headBranch = req.branchName ?? undefined
  const title = `feat: ${req.title}`
  const body = buildPrBody(req)

  // Which half of the chain is executing, so a THROWN failure is classified
  // against the stage it actually happened in rather than a guessed one.
  let stage: GitFailureStage = 'commit-push'
  try {
    // Commit and push first; only create the PR when that succeeded.
    const commit = await commitAndPush(worktreePath, title, reportStage)
    if (!commit.ok) {
      const detail = commit.error ?? '提交失败'
      return {
        success: false,
        code: 'intent.prCreateFailed',
        params: { detail },
        guidance: buildGitFailureGuidance(
          { stage: 'commit-push', text: detail },
          intentId,
          'create-pr',
        ),
      }
    }
    stage = 'forge-create'
    reportStage('creating-pr')
    const pr = await createForgePr(
      worktreePath,
      title,
      body,
      headBranch,
      baseBranch,
      providerOverride,
    )
    if (!pr.ok || !pr.prId) {
      const detail = pr.error ?? '未知错误'
      return {
        success: false,
        code: 'intent.prCreateFailed',
        params: { detail },
        guidance: buildGitFailureGuidance(
          // `unavailable` is the CLI runner's own verdict (not installed / not
          // logged in), so it is passed through rather than re-derived from text.
          { stage: 'forge-create', text: detail, cliUnavailable: pr.unavailable },
          intentId,
          'create-pr',
        ),
      }
    }
    // The PR's identity: `repo` only ever existed inside the URL the forge CLI
    // printed, and the forge is what we routed the create through. Both are
    // persisted now — the ledger keys a PR by them, and re-probing origin later
    // would be a second source of truth for a fact we already hold.
    const identity = parsePrIdentity(pr.prUrl)
    upsertIntentPr({
      intentId,
      deliveryId,
      number: pr.prId,
      status: 'reviewing',
      forge: identity.forge ?? providerOverride ?? null,
      repo: identity.repo,
      url: pr.prUrl ?? null,
      headBranch: headBranch ?? null,
      baseBranch,
    })
    safeInsertIntentLog(intentId, 'pr_created', `创建 PR #${pr.prId}`, deps.actor)
    deps.broadcastIntents(workspacePath)
    runServerSidePrCreate(
      {
        prId: pr.prId,
        prUrl: pr.prUrl ?? null,
        headBranch,
        baseBranch,
        intentId,
        deliveryId,
      },
      deps.normalizeEvent,
      (event) => deps.publishEvent(workspacePath, intentId, event),
    )
    return { success: true, prId: pr.prId, prUrl: pr.prUrl ?? pr.prId }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      code: 'intent.prCreateFailed',
      params: { detail },
      guidance: buildGitFailureGuidance({ stage, text: detail }, intentId, 'create-pr'),
    }
  }
}

/** The PR body: the intent content plus a dependency roll-up when it has any. */
function buildPrBody(req: Intent): string {
  const parts: string[] = [req.content]
  if (req.dependsOn.length > 0) {
    parts.push('', '## 依赖需求')
    for (const depId of req.dependsOn) {
      const dep = getIntent(depId)
      parts.push(`- ${dep?.title ?? depId} (${dep?.status ?? 'unknown'})`)
    }
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// update_intent_status
// ---------------------------------------------------------------------------

export interface StatusChangeDeps {
  broadcastIntents: (workspacePath: string) => void
  /** Domain event for cross-feature subscribers (ADR-0018). */
  publishStatusChanged: (input: {
    intentId: string
    workspacePath: string
    fromStatus: IntentStatus
    toStatus: IntentStatus
  }) => void
  actor?: string | null
}

/**
 * Change an intent's status.
 *
 * Cancelling an intent closes EVERY active PR it owns FIRST, and only proceeds
 * when all of them closed: a single failure blocks the cancellation entirely, so
 * the ledger never claims a cancellation the forge did not accept. PRs that DID
 * close keep their `closed` row — closing is idempotent, so a retry is not
 * derailed by the ones that already succeeded.
 */
export async function applyIntentStatusChange(
  workspacePath: string,
  intentId: string,
  status: IntentStatus,
  deps: StatusChangeDeps,
): Promise<IntentWriteResult<{ fromStatus: IntentStatus }>> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }
  const req = getIntent(intentId)
  if (!req) return { success: false, code: 'intent.notFound' }
  if (!canTransition(req.status, status)) {
    return {
      success: false,
      code: 'intent.illegalStatusTransition',
      params: { from: req.status, to: status },
    }
  }
  const toClose = status === 'cancelled' ? activeIntentPrs(req.prs) : []
  const failures: string[] = []
  for (const pr of toClose) {
    // The row's own forge wins; the workspace override is only a fallback for
    // rows backfilled before the origin was persisted.
    const close = await closeForgePr(
      workspacePath,
      pr.number,
      pr.forge ?? getForgeOverride(workspacePath),
    )
    if (!close.ok) {
      failures.push(`#${pr.number}: ${close.error ?? '未知错误'}`)
      continue
    }
    upsertIntentPr({
      intentId,
      deliveryId: pr.deliveryId,
      forge: pr.forge,
      repo: pr.repo,
      number: pr.number,
      status: 'closed',
    })
    safeInsertIntentLog(intentId, 'pr_closed', `PR #${pr.number} 已随意图取消`, deps.actor)
  }
  if (failures.length > 0) {
    // Blocked, not partially applied: the status stays put and the detail names
    // every PR the forge refused, so the operator knows exactly what to retry.
    return {
      success: false,
      code: 'intent.prCloseFailed',
      params: { detail: failures.join('; ') },
    }
  }

  const prevStatus = req.status
  updateStatus(intentId, status, deps.actor ?? 'system')
  // Leaving in_progress drops the derived caches, so a later restart cannot show
  // a stale dangling/running label.
  if (prevStatus === 'in_progress' && status !== 'in_progress') {
    clearRunStatus(intentId)
    clearJudgedSession(intentId)
  }
  deps.publishStatusChanged({ intentId, workspacePath, fromStatus: prevStatus, toStatus: status })
  publishIntentStatusTransition(workspacePath, req, prevStatus, status)
  deps.broadcastIntents(workspacePath)
  return { success: true, fromStatus: prevStatus }
}
