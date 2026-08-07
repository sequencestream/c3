/**
 * The ONE dependency-gate criterion, as a pure function of fact snapshots.
 *
 * The question the gate answers is NOT "is the dependency's PR merged" but
 * "**is the dependency's output on my base**". Under deliveries those are
 * different questions: a dependency merged into delivery branch A is invisible
 * to a session working on delivery branch B, and the PR-merged criterion would
 * admit it anyway.
 *
 * It lives in `@ccc/shared` (next to `deriveIntentPrAggregate`) because it has
 * exactly two readers that may not import each other: the feature-side gate
 * (`server/src/features/intents/dependency-gate.ts`) and the scheduling kernel
 * (`server/src/kernel/queue/reconcile.ts`) — the kernel never imports features
 * (ADR-0009), so the shared layer is the only place one implementation can serve
 * both. One implementation is the whole point: the two used to hold DIFFERENT
 * rules and could contradict each other on the same facts.
 *
 * Everything here is data in / verdict out: no I/O, no clock, no store access.
 * Each reader reduces its own world into {@link DependencyGateInput} at its own
 * boundary.
 */
import type { GitBranchMode, IntentPrStatus, IntentStatus } from './protocol.js'
import type { DeliveryGateFact } from './delivery-gate-model.js'

/** Normalise local and remote git branch references before comparison. */
export function normalizeGateBranchName(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim()
  if (!trimmed) return null
  return trimmed
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^origin\//, '')
}

/**
 * One dependency intent, reduced to the facts the criterion reads. Assembled at
 * each reader's boundary; the gate never looks anything up.
 */
export interface DependencyGateFact {
  id: string
  title: string
  status: IntentStatus
  /** The dependency's own development branch; `null` when it has none. */
  branchName: string | null
  /** Deliveries this intent is associated with (`intent_deliveries` edges). */
  deliveryIds: readonly string[]
  /**
   * This intent's PR status PER delivery, keyed by delivery id (reduced from
   * `intent_prs.delivery_id`). The same-delivery branch reads THIS rather than
   * the aggregate: a PR toward another delivery says nothing about mine.
   */
  prStatusByDelivery: Readonly<Record<string, IntentPrStatus | null>>
  /**
   * The intent's AGGREGATE PR status (`deriveIntentPrAggregate`), `null` when it
   * owns no PR. Read ONLY by the no-delivery branch, which keeps the historic
   * criterion verbatim.
   */
  prAggregate: IntentPrStatus | null
}

/** Everything one gate evaluation reads. Pure data — assembled by the caller. */
export interface DependencyGateInput {
  /** Hard dependency ids in DECLARATION order; the first blocker is reported. */
  dependsOn: readonly string[]
  /** Facts for the dependencies that could be resolved. Unknown ids stay absent. */
  dependencies: readonly DependencyGateFact[]
  /**
   * The DELIVERY CONTEXT of the session being admitted — the thing that decides
   * what "my base" is. `null` when the session has none (no association, or a
   * workspace that never adopted deliveries).
   */
  sessionDeliveryId: string | null
  /** Delivery snapshot for this workspace, by id. Missing ids read as unknown. */
  deliveries: readonly DeliveryGateFact[]
  gitBranchMode: GitBranchMode
  defaultMainBranch: string | null | undefined
}

/**
 * Why the gate is closed. Each maps to one explanation the reader renders.
 * - `not_done`               — the dependency is not finished at all.
 * - `pr_unmerged`            — SAME delivery: its PR toward my delivery is not merged.
 * - `delivery_not_delivered` — CROSS delivery: its delivery has not reached mainline.
 * - `not_on_mainline`        — no delivery context: the historic mainline criterion.
 */
export type DependencyBlockReason =
  'not_done' | 'pr_unmerged' | 'delivery_not_delivered' | 'not_on_mainline'

/**
 * The gate's verdict. Carries the facts an explanation needs (which dependency,
 * which delivery) but no error code, no locale text and no transport shape —
 * every reader mints its own.
 */
export type DependencyGateVerdict =
  | { blocked: false }
  | {
      blocked: true
      reason: DependencyBlockReason
      dependency: { id: string; title: string }
      /**
       * The delivery the explanation points at: my delivery for `pr_unmerged`,
       * the dependency's blocking delivery for `delivery_not_delivered`, `null`
       * for the two delivery-less reasons. `title` falls back to the id when the
       * delivery snapshot does not know it.
       */
      delivery: { id: string; title: string } | null
    }

/**
 * The historic, delivery-less criterion, preserved verbatim: a `done`
 * dependency is on the mainline when its aggregate PR is `merged`, when it has
 * no branch at all, or when its branch IS the workspace mainline.
 */
function isOnMainline(
  dep: DependencyGateFact,
  defaultMainBranch: string | null | undefined,
): boolean {
  if (dep.prAggregate === 'merged') return true
  const branch = normalizeGateBranchName(dep.branchName)
  if (branch === null) return true
  const mainBranch = normalizeGateBranchName(defaultMainBranch)
  return mainBranch !== null && branch === mainBranch
}

/**
 * Evaluate the dependency gate for ONE session, and return the FIRST dependency
 * (in `dependsOn` declaration order) that closes it.
 *
 * Order of evaluation, per dependency:
 *
 *   1. **Unresolvable id** → never blocks. A cross-workspace or deleted
 *      reference is a historical record, not a live obligation — every entry
 *      point has always treated it that way.
 *   2. **Not `done`** → blocks in every mode. Nothing else can be true yet.
 *   3. `current-branch` mode → nothing further applies. Every intent develops in
 *      the one shared checkout on the mainline, deliveries never give it a
 *      different base, and the historic gate stopped here too.
 *   4. **Same delivery** (my delivery context is among the dependency's
 *      associations) → its PR TOWARD THAT DELIVERY must be `merged`. Read per
 *      delivery, never as the aggregate: a PR toward another delivery is not on
 *      my base.
 *   5. **Cross delivery** (I have a delivery context, the dependency has
 *      associations but not mine) → every one of its deliveries must be
 *      `delivered`. `merged` would only prove the output reached ITS delivery
 *      branch; `delivered` is what proves it reached mainline and can therefore
 *      reach my base. Several associations collapse to the STRICTEST reading —
 *      the ledger permits many edges and "which one owns it" is not knowable, so
 *      the gate refuses to guess.
 *   6. **No delivery** (no context, or the dependency has no association) → the
 *      historic mainline criterion, unchanged.
 */
export function evaluateDependencyGate(input: DependencyGateInput): DependencyGateVerdict {
  const byId = new Map(input.dependencies.map((d) => [d.id, d]))
  const deliveryById = new Map(input.deliveries.map((d) => [d.id, d]))
  const ref = (id: string): { id: string; title: string } => ({
    id,
    title: deliveryById.get(id)?.title ?? id,
  })

  for (const depId of input.dependsOn) {
    const dep = byId.get(depId)
    if (!dep) continue
    const blocked = (
      reason: DependencyBlockReason,
      delivery: { id: string; title: string } | null,
    ): DependencyGateVerdict => ({
      blocked: true,
      reason,
      dependency: { id: dep.id, title: dep.title },
      delivery,
    })

    if (dep.status !== 'done') return blocked('not_done', null)
    if (input.gitBranchMode !== 'worktree') continue

    const mine = input.sessionDeliveryId
    if (mine !== null && dep.deliveryIds.includes(mine)) {
      if (dep.prStatusByDelivery[mine] !== 'merged') return blocked('pr_unmerged', ref(mine))
      continue
    }
    if (mine !== null && dep.deliveryIds.length > 0) {
      const pending = dep.deliveryIds.find((id) => deliveryById.get(id)?.status !== 'delivered')
      if (pending !== undefined) return blocked('delivery_not_delivered', ref(pending))
      continue
    }
    if (!isOnMainline(dep, input.defaultMainBranch)) return blocked('not_on_mainline', null)
  }
  return { blocked: false }
}

/**
 * Whether a blocked verdict should trigger a best-effort PR-status refresh.
 *
 * True for the two PR-SHAPED blocks — `pr_unmerged` (same delivery) and
 * `not_on_mainline` (no delivery, where the criterion still turns on the
 * aggregate PR being merged). A stale `reviewing` row is the commonest false
 * block on both, and nothing else clears it: without the refresh the gate would
 * sit closed on a PR that merged hours ago.
 *
 * False for `delivery_not_delivered` (a delivery's status is a local ledger fact
 * — no forge call can change it) and for `not_done` (nothing about a PR is being
 * asked).
 */
export function gateWantsPrStatusSync(verdict: DependencyGateVerdict): boolean {
  return (
    verdict.blocked && (verdict.reason === 'pr_unmerged' || verdict.reason === 'not_on_mainline')
  )
}
