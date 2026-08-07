/**
 * The feature-side ADAPTER over the one dependency criterion.
 *
 * The rule itself lives in `@ccc/shared` ({@link evaluateDependencyGate}) because
 * the queue kernel needs the very same one and may not import features
 * (ADR-0009). Everything here is the boundary work that pure function refuses to
 * do: read the ledger, reduce intents and deliveries into facts, and translate a
 * verdict into this layer's shapes. No criterion is re-stated in this file — a
 * second statement is exactly how the manual path and the queue path came to
 * disagree in the first place.
 */
import type { GitBranchMode, Intent, SpecLaunchStage } from '@ccc/shared/protocol'
import {
  deriveIntentPrAggregate,
  evaluateDependencyGate,
  gateWantsPrStatusSync,
  normalizeGateBranchName,
  type DependencyGateFact,
  type DependencyGateVerdict,
  type DeliveryGateFact,
  type UiErrorCode,
} from '@ccc/shared'
import { getDefaultMainBranch, getGitBranchMode } from '../../kernel/config/index.js'
import { listIntents } from './store.js'
import { deliveryGateFacts, impliedDeliveryContextId } from './delivery-context.js'
import { syncUnconfirmedDependencyPrsInBackground } from './pr-status-sync.js'
import { pullCurrentBranch } from './worktree.js'

/** Normalise local and remote git branch references before comparison. */
export const normalizeBranchName = normalizeGateBranchName

/**
 * Reduce one intent into the dependency facts the criterion reads.
 *
 * `prStatusByDelivery` is keyed by delivery id because the ledger holds at most
 * one PR per `(intent, delivery)` pair: the same-delivery branch of the gate asks
 * about MY delivery's row, and the aggregate — which mixes in PRs toward other
 * deliveries — would answer a different question.
 */
export function toDependencyGateFact(dep: Intent): DependencyGateFact {
  const prStatusByDelivery: Record<string, DependencyGateFact['prAggregate']> = {}
  for (const pr of dep.prs) {
    if (pr.deliveryId !== null) prStatusByDelivery[pr.deliveryId] = pr.status
  }
  return {
    id: dep.id,
    title: dep.title,
    status: dep.status,
    branchName: dep.branchName,
    deliveryIds: dep.linkedDeliveries.map((d) => d.id),
    prStatusByDelivery,
    prAggregate: deriveIntentPrAggregate(dep.prs),
  }
}

/** What an evaluation needs beyond the ledger, so callers can pass what they hold. */
export interface DependencyGateContext {
  workspacePath: string
  dependsOn: readonly string[]
  /** The session's delivery context; `null` = none (see `delivery-context.ts`). */
  sessionDeliveryId: string | null
  /** Pre-loaded workspace intents, when the caller already read them. */
  intents?: readonly Intent[]
  /** Pre-loaded delivery snapshot, when the caller already read it. */
  deliveries?: readonly DeliveryGateFact[]
  gitBranchMode?: GitBranchMode
  defaultMainBranch?: string | null
}

/**
 * Evaluate the dependency gate for one intent in one delivery context. The ONLY
 * feature-side entry point: every caller (launch, resume, spec launch, the
 * read-model projection) goes through here, so an explanation can never
 * contradict a refusal.
 */
export function evaluateIntentDependencyGate(ctx: DependencyGateContext): DependencyGateVerdict {
  const { workspacePath } = ctx
  const intents = ctx.intents ?? listIntents(workspacePath)
  return evaluateDependencyGate({
    dependsOn: ctx.dependsOn,
    dependencies: intents.map(toDependencyGateFact),
    sessionDeliveryId: ctx.sessionDeliveryId,
    deliveries: ctx.deliveries ?? deliveryGateFacts(workspacePath),
    gitBranchMode: ctx.gitBranchMode ?? getGitBranchMode(workspacePath),
    defaultMainBranch: ctx.defaultMainBranch ?? getDefaultMainBranch(workspacePath),
  })
}

/**
 * The blocking dependency as a read-model projection would show it, or
 * `undefined` when the gate is open. Used where only "who am I waiting for"
 * matters (the action descriptor); anything that must EXPLAIN the wait reads the
 * verdict itself, which carries the reason and the delivery.
 *
 * The context is the intent's IMPLIED one (see `impliedDeliveryContextId`): a
 * projection has no session and cannot ask, so an intent with several
 * associations is projected under the delivery-less criterion.
 */
export function findBlockingDependency(input: {
  intent: Pick<Intent, 'dependsOn' | 'linkedDeliveries'>
  workspacePath: string
  intents: readonly Intent[]
  gitBranchMode?: GitBranchMode
  defaultMainBranch?: string | null
}): { id: string; title: string } | undefined {
  const verdict = evaluateIntentDependencyGate({
    workspacePath: input.workspacePath,
    dependsOn: input.intent.dependsOn,
    sessionDeliveryId: impliedDeliveryContextId(input.intent),
    intents: input.intents,
    gitBranchMode: input.gitBranchMode,
    defaultMainBranch: input.defaultMainBranch,
  })
  return verdict.blocked ? verdict.dependency : undefined
}

/**
 * Run the `pr_unmerged` side effect: a stale `reviewing` row is the commonest
 * false block, so a blocked-on-PR verdict kicks off a fire-and-forget refresh.
 * A `delivery_not_delivered` block never does — a delivery's status is a local
 * ledger fact, and there is no forge to ask.
 */
export function syncPrStatusForVerdict(input: {
  verdict: DependencyGateVerdict
  workspacePath: string
  dependsOn: string[]
  broadcastIntents: (workspacePath: string) => void
}): void {
  if (!gateWantsPrStatusSync(input.verdict)) return
  syncUnconfirmedDependencyPrsInBackground({
    ctx: { broadcastIntents: input.broadcastIntents },
    workspacePath: input.workspacePath,
    dependsOn: input.dependsOn,
  })
}

/**
 * Translate a blocked verdict into the `{code, params}` pair every entry point
 * hands back. Minted HERE rather than at each call site so the three states can
 * never be explained differently by two surfaces:
 *
 * - `pr_unmerged`            → 「依赖在交付 X 中的 PR 未合入」
 * - `delivery_not_delivered` → 「依赖在交付 X,该交付未合入主线」(+ jump target)
 * - `not_done` / `not_on_mainline` → the historic `intent.dependencyNotMerged`.
 *
 * `deliveryId` travels as a param on the two delivery states so the page can
 * link straight to the delivery that is holding the work back.
 */
export function dependencyGateRejection(
  verdict: Extract<DependencyGateVerdict, { blocked: true }>,
): { code: UiErrorCode; params: Record<string, string> } {
  const base = { title: verdict.dependency.title, id: verdict.dependency.id }
  if (verdict.delivery === null) {
    return { code: 'intent.dependencyNotMerged', params: base }
  }
  const params = {
    ...base,
    deliveryTitle: verdict.delivery.title,
    deliveryId: verdict.delivery.id,
  }
  return {
    code:
      verdict.reason === 'pr_unmerged'
        ? 'intent.dependencyPrUnmergedInDelivery'
        : 'intent.dependencyDeliveryNotDelivered',
    params,
  }
}

/**
 * The outcome of the spec-launch gate, stated as a DOMAIN fact only: either the
 * launch may proceed, or the dependency criterion is closed. It carries the
 * verdict verbatim (reason + dependency + delivery) but no error code, no frame
 * and no launch result — every entry point mints its own rejection shape, so
 * transport never leaks back in here.
 */
export type SpecLaunchGateResult =
  { blocked: false } | { blocked: true; verdict: Extract<DependencyGateVerdict, { blocked: true }> }

/**
 * The ONE spec-launch precondition: the dependency gate followed by a
 * best-effort pull of the current branch. Shared verbatim by the manual entry
 * (`reset_spec_session`) and by every branch of `launchSpecSession` (which the
 * `write_spec` handler, the automation MCP tool and the queue all reach), so an
 * unattended launch can never admit an intent the manual one would refuse.
 *
 * A spec session writes only the spec directory and never roots a worktree, so
 * it takes no explicit delivery context: it evaluates under the intent's IMPLIED
 * one — its single association, or the delivery-less criterion when it has none
 * or several.
 *
 * Order is part of the contract:
 *   1. Evaluate the dependency criterion.
 *   2. Blocked → run the verdict's PR-status side effect and return. Nothing is
 *      pulled and no progress is reported: the caller is about to refuse.
 *   3. Otherwise report `pulling-code`, pull, then report `launching`. A failed
 *      pull is a warning, not a refusal — the session still starts.
 */
export function prepareSpecLaunch(input: {
  workspacePath: string
  intent: Intent
  broadcastIntents: (workspacePath: string) => void
  progress?: (stage: SpecLaunchStage) => void
}): SpecLaunchGateResult {
  const { workspacePath, intent } = input
  const verdict = evaluateIntentDependencyGate({
    workspacePath,
    dependsOn: intent.dependsOn,
    sessionDeliveryId: impliedDeliveryContextId(intent),
  })
  if (verdict.blocked) {
    syncPrStatusForVerdict({
      verdict,
      workspacePath,
      dependsOn: intent.dependsOn,
      broadcastIntents: input.broadcastIntents,
    })
    return { blocked: true, verdict }
  }
  input.progress?.('pulling-code')
  const pull = pullCurrentBranch(workspacePath)
  if (!pull.ok) {
    console.warn(`[c3:intents] spec session pull failed; continuing: ${pull.message ?? 'unknown'}`)
  }
  input.progress?.('launching')
  return { blocked: false }
}
