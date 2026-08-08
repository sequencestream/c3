/**
 * Delivery — a batch of intents integrated into mainline as one unit.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 *
 * 交付中文界面固定译法见 `doc/i18n/i18n-terms.md`;不得用「已完成」「进行中」
 * 描述 delivery 状态(与 intent 状态词面混淆)。状态机的可达性与守卫由服务端
 * 计算(`canTransitionDelivery`),客户端只消费服务端给出的 `transitionPlan`,
 * 不复制状态规则。
 */
import type { IntentPrForge, IntentPrStatus, IntentStatus } from './intent.js'

/**
 * Delivery lifecycle status (中文:待集成/集成中/验证中/验证通过/已发布/已取消).
 * - `planned` — created, not yet integrating.
 * - `integrating` — the associated intents' PRs are being merged into the
 *   delivery branch.
 * - `verifying` — the integrated result is being verified.
 * - `verified` — verification passed (human-confirmed).
 * - `delivered` — the delivery branch merged into mainline; terminal.
 * - `cancelled` — abandoned; terminal.
 *
 * 没有「已完成」态:它等于「所有关联意图的 PR 已合入交付分支」这一可推导
 * 事实,只以「集成就绪 N/M」呈现,避免状态与真实 PR 漂移。
 */
export type DeliveryStatus =
  'planned' | 'integrating' | 'verifying' | 'verified' | 'delivered' | 'cancelled'

/** The runtime value domain of {@link DeliveryStatus}, for narrowing untrusted input. */
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'planned',
  'integrating',
  'verifying',
  'verified',
  'delivered',
  'cancelled',
]

/**
 * Real-time integration-readiness aggregate for a delivery, derived from its
 * associated intents' PR facts — NEVER persisted (a redundant column would
 * drift the moment an association is removed or a PR status changes).
 * - `total` — M: how many intents are associated with this delivery.
 * - `merged` — N: of those, how many have their PR toward this delivery merged.
 *
 * With no associations this reads `0/0`, which still never passes the
 * `integrating → verifying` guard (that guard requires ≥ 1 association).
 */
export interface DeliveryIntegration {
  /** N — associated intents whose PR toward this delivery is `merged`. */
  merged: number
  /** M — intents associated with this delivery. */
  total: number
}

/**
 * One delivery — the Git lifecycle unit for a batch of intents. `workspaceId`
 * is the opaque workspace id (same convention as other domain models); the
 * wire carries the computed `integration` aggregate, never a persisted count.
 */
export interface Delivery {
  /** Stable uuid. */
  id: string
  /** Owning workspace (opaque id). */
  workspaceId: string
  title: string
  description: string
  status: DeliveryStatus
  /** User-chosen calendar dates (epoch ms); `null` = unset. */
  startDate: number | null
  endDate: number | null
  /** The delivery branch; `null` until a later branch capability creates one. */
  branchName: string | null
  /**
   * Snapshot of the workspace's effective main branch taken at creation — a
   * later config change must not re-point an existing delivery at a branch it
   * was never based on. Always non-empty.
   */
  baseBranch: string
  /** Whether the delivery branch exists and is ready. Always false this phase. */
  branchReady: boolean
  /** Real-time integration aggregate (N/M), computed, never persisted. */
  integration: DeliveryIntegration
  createdAt: number
  updatedAt: number
}

/**
 * Why a delivery PR cannot be merged even though its code is fine. Deliberately
 * separate from a merge conflict: a conflict means the code needs changing (the
 * delivery goes back to `verifying`), while these two mean the code is fine and
 * an EXTERNAL condition is missing — the delivery stays `verified` and the page
 * shows 「合并受阻」 rather than making the user redo the verification.
 * - `ci_failed` — the forge's checks are failing.
 * - `approval` — the required review approvals are missing.
 */
export type DeliveryPrBlockedReason = 'ci_failed' | 'approval'

/**
 * The PR that carries a delivery into mainline (head = the delivery branch,
 * base = the delivery's `baseBranch` snapshot).
 *
 * A DIFFERENT entity from an `IntentPr`, and stored in its own table: an intent
 * PR targets the delivery branch and feeds the 「集成就绪 N/M」 aggregate, while
 * this one targets mainline and never counts toward it. Merging it is what makes
 * the delivery `delivered`, and only a human does that — on the forge.
 */
export interface DeliveryPr {
  /** Owning delivery. */
  deliveryId: string
  forge: IntentPrForge | null
  /** Repository identifier in `owner/name` form; `null` when the origin is unknown. */
  repo: string | null
  /** In-repo PR / MR number (what the forge CLIs address a change request by). */
  number: string
  /** Clickable link; `null` when unknown. */
  url: string | null
  /** The delivery branch. */
  headBranch: string
  /** Mainline — the delivery's `baseBranch` snapshot. */
  baseBranch: string
  /** `origin/<baseBranch>` head at the last create / sync — half the idempotency key. */
  baseSha: string
  /** `origin/<headBranch>` head at the last create / sync — the other half. */
  headSha: string
  /** Same value domain as an intent PR's status; only these three ever occur here. */
  status: Extract<IntentPrStatus, 'reviewing' | 'merged' | 'closed'>
  /** Why an OPEN PR cannot be merged; `null` when nothing blocks it. */
  blockedReason: DeliveryPrBlockedReason | null
  /**
   * Files the local merge trial reported as conflicting, recorded when the forge
   * judged the PR unmergeable. Empty when the trial itself could not run — the
   * forge's verdict is sufficient on its own, so the delivery still goes back to
   * `verifying` with only the SHA pair to explain the state.
   */
  conflictFiles: string[]
  createdAt: number
  updatedAt: number
}

/**
 * One intent linked to a delivery, as the delivery detail renders it.
 *
 * `prStatus` is deliberately **this intent's PR toward THIS delivery** (the
 * `intent_prs` row whose `delivery_id` is the delivery being viewed) — NOT the
 * intent's global PR state. An intent can hold one PR per delivery, so a global
 * reduction would show another delivery's status in this delivery's list.
 */
export interface AssociatedIntent {
  id: string
  title: string
  status: IntentStatus
  /** Status of this intent's PR toward this delivery; `null` when it has none. */
  prStatus: IntentPrStatus | null
  /** Head branch of that PR; `null` when there is no PR or it is unknown. */
  headBranch: string | null
  /** Number of that PR within its repo; `null` when there is no PR. */
  prNumber: string | null
  /** Link to that PR on the forge; `null` when there is no PR or no URL. */
  prUrl: string | null
}

/**
 * A guard-gap reason on a legal-but-blocked transition. `code` is a
 * `delivery.guard.*` locale leaf; `jumpTo` tells the page where the user can
 * act on the gap (`null`/absent = no jump target this phase).
 */
export type DeliveryGuardReasonCode =
  | 'delivery.guard.branchNotReady'
  | 'delivery.guard.noAssociatedIntents'
  | 'delivery.guard.prsNotMerged'
  | 'delivery.guard.verificationNotConfirmed'
  | 'delivery.guard.mergeNotSucceeded'
  | 'delivery.guard.systemOnly'
  | 'delivery.guard.humanOnly'
  | 'delivery.guard.mergeConflictReasonRequired'

export interface DeliveryGuardReason {
  code: DeliveryGuardReasonCode
  /** Interpolation params for the locale leaf, if any. */
  params?: Record<string, string | number>
  /**
   * Where the page can take the user to resolve this gap: the associated-intents
   * tab, the workspace settings, or the delivery's own branch-init section
   * (the `branchNotReady` gap jumps there once branch init ships).
   */
  jumpTo?: 'associated-intents' | 'workspace-settings' | 'branch'
}

/**
 * One legal progress target reachable from a delivery's current status, with
 * its guard verdict. The page renders the segmented selector from these — an
 * illegal target never appears, a legal-but-blocked one renders greyed with
 * its reasons.
 */
export interface DeliveryTargetTransition {
  to: DeliveryStatus
  /**
   * Whether a human may invoke this edge. A system-only edge (`verified →
   * delivered`, `verified → verifying`) is never human-invokable.
   */
  humanAction: boolean
  /** Guard verdict — `satisfied` means the edge is executable right now. */
  guard: 'satisfied' | 'failed'
  /** Unmet gaps in guard order; empty when satisfied or the edge has no data guard. */
  reasons: DeliveryGuardReason[]
}

/** Server-computed reachability + gaps for one delivery's current status. */
export interface DeliveryTransitionPlan {
  targets: DeliveryTargetTransition[]
}
