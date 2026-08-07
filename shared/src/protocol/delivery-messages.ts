/**
 * Delivery wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
  AssociatedIntent,
  Delivery,
  DeliveryGuardReason,
  DeliveryStatus,
  DeliveryTransitionPlan,
} from './delivery.js'

/** List a workspace's deliveries (reply/broadcast: `deliveries`). */
export type ClientListDeliveries = { type: 'list_deliveries'; workspaceId: string }

/**
 * Create one delivery. Pure local data action — never touches git / forge.
 * The server snapshots the workspace's current effective main branch into
 * `base_branch` at create time, and the reply carries the one-time `pr:merge`
 * semantic-change notice when this is the workspace's first delivery ever.
 */
export type ClientCreateDelivery = {
  type: 'create_delivery'
  workspaceId: string
  title: string
  description?: string
  startDate?: number | null
  endDate?: number | null
}

/** Open one delivery's detail (reply: `delivery_detail` with its transition plan). */
export type ClientGetDeliveryDetail = { type: 'get_delivery_detail'; deliveryId: string }

/**
 * Edit a delivery's data fields. Pure local action; status is untouched here
 * (status changes go through `transition_delivery` / `cancel_delivery`).
 */
export type ClientUpdateDelivery = {
  type: 'update_delivery'
  workspaceId: string
  deliveryId: string
  title?: string
  description?: string
  startDate?: number | null
  endDate?: number | null
}

/**
 * Cancel a delivery — the lifecycle-terminating write (no permanent delete
 * exists). Goes through the same state machine as `transition_delivery`
 * (`<non-terminal> → cancelled`); cancelling a terminal delivery is rejected.
 * Cancel never clears associated facts or remote resources.
 */
export type ClientCancelDelivery = {
  type: 'cancel_delivery'
  workspaceId: string
  deliveryId: string
}

/**
 * Advance / rework a delivery's status. The server re-evaluates the state
 * machine + guards at write time (`canTransitionDelivery`) and recomputes gaps
 * from current facts — a stale client plan is rejected. `confirmVerified` is the
 * explicit human verification-confirmation required by `verifying → verified`;
 * the page cannot auto-advance it. `to` may be any state; an illegal edge is
 * rejected, and system-only edges (`verified → delivered`,
 * `verified → verifying`) are refused for a human writer.
 */
export type ClientTransitionDelivery = {
  type: 'transition_delivery'
  workspaceId: string
  deliveryId: string
  to: DeliveryStatus
  confirmVerified?: boolean
}

/**
 * Initialize the delivery's remote branch — the EXPLICIT, retryable Git action
 * that gives the delivery its real integration branch. Pure Git work; the DB is
 * written only after a push (create) or a verified remote existence (bind /
 * orphan idempotent bind) succeeds.
 *
 * - `mode: 'create'` — create the branch on the remote rooted at the just-fetched
 *   `origin/<base_branch>` HEAD. If the remote branch already exists with that
 *   exact head, it is treated as an orphan from a previous failed write and bound
 *   idempotently (no push); a mismatch is refused as `delivery.branchConflict`.
 * - `mode: 'bind'` — bind an EXISTING remote branch (e.g. a company `release/*`).
 *   The remote branch must exist; divergence from the baseline is only a warning
 *   (`delivery.branchBehindMain`), never a rejection.
 */
export type ClientInitDeliveryBranch = {
  type: 'init_delivery_branch'
  workspaceId: string
  deliveryId: string
  branchName: string
  mode: 'create' | 'bind'
}

/**
 * Clear a TERMINAL (`delivered` / `cancelled`) delivery's local branch
 * reference. Never touches the remote branch — deleting a remote branch is
 * irreversible, so it is never automated. Refused on a non-terminal delivery.
 */
export type ClientCleanupDeliveryBranch = {
  type: 'cleanup_delivery_branch'
  workspaceId: string
  deliveryId: string
}

/**
 * Link an intent to a delivery — creates the association edge the integration
 * aggregate and every delivery guard read from. Owned by the DELIVERY domain,
 * not the intent domain: the edge's whole lifecycle (merged-unlink denial, the
 * N/M aggregate) is delivery context, and putting it under `intent` would make
 * the intent domain depend backwards on delivery rules.
 *
 * Purely additive — an existing PR without a delivery binding is NOT re-targeted
 * here (PR re-basing is a later capability). Reply: `delivery_detail`, carrying
 * `linkWarning: 'delivery.diffBloat'` when the intent's commits are rooted on
 * mainline rather than on the delivery branch.
 */
export type ClientLinkIntentToDelivery = {
  type: 'link_intent_to_delivery'
  workspaceId: string
  deliveryId: string
  intentId: string
}

/**
 * Unlink an intent from a delivery. Guarded, and never a pure DB delete:
 *
 * - A PR toward this delivery that is ALREADY MERGED can never be unlinked
 *   (`delivery.unlinkMergedPrDenied`) — the code is already on the delivery
 *   branch, so dropping the edge would leave "the association is gone but the
 *   code is in", falsifying the N/M aggregate with no way back but a revert.
 *   Checked locally AND against the forge, so a remotely-merged PR the ledger
 *   has not caught up with is still refused.
 * - An unmerged PR is CLOSED first; only then is the edge dropped. A close
 *   failure blocks the whole unlink (`delivery.unlinkClosePrFailed`).
 * - When the forge status cannot be read at all, the unlink is refused
 *   (`delivery.unlinkPrStatusCheckFailed`) rather than guessed.
 */
export type ClientUnlinkIntentFromDelivery = {
  type: 'unlink_intent_from_delivery'
  workspaceId: string
  deliveryId: string
  intentId: string
}

/**
 * Merge `origin/<base_branch>` into the delivery branch and push — the
 * 「同步主线」action. Always user-invoked and always confirmed: c3 never
 * schedules it, because a background job that silently rewrites a shared branch
 * (and whose failures nobody reads) is precisely what the never-auto-merge
 * stance exists to prevent.
 *
 * Only meaningful while a delivery is `integrating`; its purpose is to move
 * conflict handling EARLIER, so the final `verified → delivered` merge lands
 * close to a fast-forward. Conflicts are surfaced verbatim and never resolved.
 *
 * Reply: `delivery_sync_mainline_result`, preceded by
 * `delivery_sync_mainline_progress` frames.
 */
export type ClientSyncDeliveryMainline = {
  type: 'sync_delivery_mainline'
  workspaceId: string
  deliveryId: string
}

// ---- Server → Client ----

/**
 * A workspace's delivery list. `needsActionCount` is the server-computed
 * badge figure — "deliveries needing user attention" in the current workspace
 * (an unresolved human-solvable gap, or an executable human forward/rework
 * action; pure system waits, terminals and Git actions hidden under
 * `current-branch` never count). Cancel itself never puts a delivery into it.
 */
export type ServerDeliveries = {
  type: 'deliveries'
  workspaceId: string
  items: Delivery[]
  needsActionCount: number
}

/** Exact result for `create_delivery`; the regular `deliveries` snapshot follows. */
export type ServerCreateDeliveryResult = {
  type: 'create_delivery_result'
  workspaceId: string
  delivery: Delivery
  /**
   * One-time `pr:merge` semantic-change notice. True ONLY on the first delivery
   * ever created in this workspace (cancelled records still count, so restart /
   * re-create / another client never re-shows it); the client shows it once and
   * never again. This is the only defense against the drift — by the time
   * `pr:merge` may target the delivery branch, the event is already emitted and
   * automations already ran, so the notice is raised BEFORE the semantics widen.
   */
  prMergeNotice: boolean
}

/**
 * One delivery's detail: the model + the server-computed transition plan + the
 * intents linked to it. The single reply for every delivery write that changes
 * the detail (update / transition / cancel / branch cleanup / link / unlink).
 */
export type ServerDeliveryDetail = {
  type: 'delivery_detail'
  delivery: Delivery
  transitionPlan: DeliveryTransitionPlan
  /** Intents linked to this delivery, by title; each row's PR status is toward THIS delivery. */
  associatedIntents: AssociatedIntent[]
  /**
   * How many commits `origin/<base_branch>` holds that the delivery branch does
   * not, from the LOCAL remote-tracking refs — the page shows 「主线领先」 from
   * it and offers 「同步主线」. `null` when it cannot be determined (no branch
   * yet, refs unresolvable, `current-branch` mode). Read without fetching: an
   * automatic network round trip on every detail open would be slow and
   * surprising, and the refs are refreshed by every branch/PR/sync action.
   */
  mainlineAhead: number | null
  /**
   * Set ONLY on the reply to a `link_intent_to_delivery` that detected diff
   * bloat: the intent's commits branch off mainline past the delivery branch's
   * fork point, so a PR toward the delivery branch would carry the whole
   * mainline-vs-delivery difference. The link still succeeded — this is a
   * warning the page surfaces, never a rejection.
   */
  linkWarning?: 'delivery.diffBloat'
}

/**
 * A refused status write. Sent instead of a plain `error` so the page can
 * render the legal-target set + concrete gaps from server truth. On an illegal
 * edge (`code: delivery.invalidStatusTransition`) `reasons` is empty; on a
 * legal-but-blocked edge (`code: delivery.transitionGuardFailed`) `reasons`
 * carries the unmet `delivery.guard.*` gaps in guard order. `currentStatus` is
 * the unchanged status after the refused write.
 */
export type ServerDeliveryTransitionFailed = {
  type: 'delivery_transition_failed'
  deliveryId: string
  code: 'delivery.invalidStatusTransition' | 'delivery.transitionGuardFailed'
  reasons: DeliveryGuardReason[]
  /** The unchanged status after the refused write. */
  currentStatus: DeliveryStatus
  /** The status the caller tried to move to (for the `error.delivery.*` copy). */
  to: DeliveryStatus
}

/**
 * One coarse phase boundary of a delivery branch-init run. Internal to this
 * partition (like every payload type here) — a public export would count as a
 * message payload leaking onto the `@ccc/shared/protocol` surface.
 */
type DeliveryBranchInitPhase = 'fetching' | 'creating' | 'pushing' | 'binding'

/**
 * Coarse progress of an `init_delivery_branch` run, pushed to the requesting
 * connection. Phases advance `fetching → creating → pushing` on the create path
 * (the binding paths report a single `binding`); a repeat or back-step is a
 * client-side concern, never re-sent by the server.
 */
export type ServerDeliveryBranchInitProgress = {
  type: 'delivery_branch_init_progress'
  deliveryId: string
  phase: DeliveryBranchInitPhase
}

/**
 * Success terminal of an `init_delivery_branch` run. `delivery` carries the
 * updated model (`branchName` + `branchReady`); the page re-fetches the detail
 * for the fresh transition plan, and `deliveries` is broadcast. `warning` is set
 * when a `bind` found the remote branch diverging from the baseline — the branch
 * is bound regardless (spec: only warn, never reject legal release branches).
 */
export type ServerDeliveryBranchInitResult = {
  type: 'delivery_branch_init_result'
  workspaceId: string
  delivery: Delivery
  warning?: 'delivery.branchBehindMain'
}

/** Coarse progress of a `sync_delivery_mainline` run, to the requesting connection. */
export type ServerDeliverySyncMainlineProgress = {
  type: 'delivery_sync_mainline_progress'
  deliveryId: string
  phase: 'fetching' | 'merging' | 'pushing'
}

/**
 * Terminal of a `sync_delivery_mainline` run. `ahead` is how many commits
 * mainline held that the delivery branch did not BEFORE the merge — `0` means
 * there was nothing to sync, which is a success, not a no-op error. Failures
 * travel as a plain `error` frame; this frame is only ever sent on success.
 */
export type ServerDeliverySyncMainlineResult = {
  type: 'delivery_sync_mainline_result'
  deliveryId: string
  ahead: number
}
