/**
 * Delivery wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
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

/** One delivery's detail: the model + the server-computed transition plan. */
export type ServerDeliveryDetail = {
  type: 'delivery_detail'
  delivery: Delivery
  transitionPlan: DeliveryTransitionPlan
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

/** One coarse phase boundary of a delivery branch-init run. */
export type DeliveryBranchInitPhase = 'fetching' | 'creating' | 'pushing' | 'binding'

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
