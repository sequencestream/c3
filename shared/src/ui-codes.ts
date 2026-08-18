/**
 * Single source of truth (SoT) for UI-facing error codes.
 *
 * The server sends machine-readable `{ code, params }` for anything shown in the
 * browser — never translated text. The web maps `code` to an i18n leaf key via
 * this table and renders `t(key, params)`. So translations live ONCE, in the web
 * locale catalog; the server stays language-free (its logs/debug output remain
 * English and are NOT modeled here).
 *
 * Both `code` (the wire identifier) and `key` (the web i18n leaf) are English
 * constants and MUST NOT be translated. A build-time generator derives the
 * `code → key` map from this file, and `pnpm i18n:check` asserts every `key`
 * exists in `en.json` and that the declared `params` match its placeholders.
 *
 * This is the one runtime module in `@ccc/shared` (the rest is type-only); web
 * imports `UI_ERROR_CODES` to translate, the server imports `UiErrorCode` for
 * type-safe `send()` payloads. See specs/shared/api-conventions/websocket-protocol.md
 * and changes/.../2026-06-04-003-server-code-params-protocol/spec.md.
 */
import type { GitActionFailureGuidance } from './protocol/intent.js'

/** One UI error code's mapping: the web i18n leaf key it renders through. */
export interface UiErrorDef {
  /** Leaf key under the frozen `error` namespace in the web locale catalog. */
  readonly key: string
  /** Allowed interpolation param names for `key`; checked against en.json placeholders. */
  readonly params?: readonly string[]
}

/**
 * The registry. Add a code here, add its `error.*` key to `en.json` (+ every
 * other locale), and `i18n:check` keeps the three in sync. Codes are dot-cased
 * `<domain>.<reason>` mirroring the `error.<domain>.<reason>` locale key.
 */
export const UI_ERROR_CODES = {
  // workspace / path / commands
  'workspace.unknown': { key: 'error.workspace.unknown', params: ['path'] },
  'workspace.nameInvalid': { key: 'error.workspace.nameInvalid' },
  'workspace.nameConflict': { key: 'error.workspace.nameConflict' },
  // No native directory chooser could run on the server host (unsupported
  // platform, missing executable, no GUI, unusable output). Deliberately
  // param-free: raw command output stays in the server log, never in the UI.
  'workspace.directoryPickerFailed': { key: 'error.workspace.directoryPickerFailed' },
  'path.notDirectory': { key: 'error.path.notDirectory', params: ['path'] },
  'command.listFailed': { key: 'error.command.listFailed', params: ['detail'] },
  // files
  'files.invalidPath': { key: 'error.files.invalidPath', params: ['path'] },
  'files.notDirectory': { key: 'error.files.notDirectory', params: ['path'] },
  'files.notFile': { key: 'error.files.notFile', params: ['path'] },
  'files.readFailed': { key: 'error.files.readFailed', params: ['path'] },
  'files.searchFailed': { key: 'error.files.searchFailed' },
  // session
  'session.listFailed': { key: 'error.session.listFailed', params: ['detail'] },
  'session.openFailed': { key: 'error.session.openFailed', params: ['detail'] },
  'session.deleteFailed': { key: 'error.session.deleteFailed', params: ['detail'] },
  'session.renameFailed': { key: 'error.session.renameFailed', params: ['detail'] },
  'session.notSelected': { key: 'error.session.notSelected' },
  'session.turnRunning': { key: 'error.session.turnRunning' },
  'session.readOnly': { key: 'error.session.readOnly' },
  // prompt input
  'prompt.unsupportedFile': { key: 'error.prompt.unsupportedFile', params: ['mediaType'] },
  // intent
  'intent.notFound': { key: 'error.intent.notFound' },
  'intent.dbUnavailable': { key: 'error.intent.dbUnavailable' },
  'intent.specModeLocked': { key: 'error.intent.specModeLocked' },
  'intent.chatOpenFailed': { key: 'error.intent.chatOpenFailed' },
  'intent.chatSessionNotFound': { key: 'error.intent.chatSessionNotFound', params: ['sessionId'] },
  'intent.renameChatSessionFailed': {
    key: 'error.intent.renameChatSessionFailed',
    params: ['detail'],
  },
  'intent.deleteChatSessionFailed': {
    key: 'error.intent.deleteChatSessionFailed',
    params: ['detail'],
  },
  'intent.deleteFailed': { key: 'error.intent.deleteFailed', params: ['detail'] },
  'intent.createFailed': { key: 'error.intent.createFailed', params: ['detail'] },
  // A create asked to base the intent on a branch but sent no usable name. The
  // create is refused rather than silently falling back to the main branch: a
  // base branch nobody chose is exactly the un-auditable state the snapshot
  // exists to remove.
  'intent.baseBranchRequired': { key: 'error.intent.baseBranchRequired' },
  'intent.startSessionFailed': { key: 'error.intent.startSessionFailed', params: ['detail'] },
  'intent.sessionAlreadyBound': { key: 'error.intent.sessionAlreadyBound' },
  'intent.deleteForbidden': { key: 'error.intent.deleteForbidden', params: ['detail'] },
  'intent.cannotStartDev': { key: 'error.intent.cannotStartDev', params: ['status'] },
  // Workspace-global concurrency gate (RM-A12), enforced inside the shared work
  // session launcher so the manual button and the MCP tool share ONE gate.
  'intent.concurrencyGate': { key: 'error.intent.concurrencyGate', params: ['title'] },
  // A work session paused on an unanswered AskUserQuestion is never continued
  // over: the continuation prompt must not stand in for the user's answer.
  'intent.pendingQuestionUnanswered': { key: 'error.intent.pendingQuestionUnanswered' },
  'intent.contentEditForbidden': { key: 'error.intent.contentEditForbidden', params: ['status'] },
  'intent.devStartInFlight': { key: 'error.intent.devStartInFlight' },
  'intent.illegalStatusTransition': {
    key: 'error.intent.illegalStatusTransition',
    params: ['from', 'to'],
  },
  'intent.prCreateFailed': {
    key: 'error.intent.prCreateFailed',
    params: ['detail'],
  },
  // Manual create_pr gate rejections (worktree mode + branch + committable changes).
  'intent.prCreateNotWorktree': { key: 'error.intent.prCreateNotWorktree' },
  'intent.prCreateNoBranch': { key: 'error.intent.prCreateNoBranch' },
  'intent.prCreateNoChanges': { key: 'error.intent.prCreateNoChanges' },
  'intent.prCloseFailed': {
    key: 'error.intent.prCloseFailed',
    params: ['detail'],
  },
  'intent.worktreeCreateFailed': {
    key: 'error.intent.worktreeCreateFailed',
    params: ['message'],
  },
  'intent.pullFailed': {
    key: 'error.intent.pullFailed',
    params: ['message'],
  },
  // Dependency gate, delivery-less branch: the historic "not on the mainline yet"
  // refusal, unchanged in wording and in criterion.
  'intent.dependencyNotMerged': {
    key: 'error.intent.dependencyNotMerged',
    params: ['title', 'id'],
  },
  // Dependency gate, SAME delivery: the dependency's PR toward MY delivery is not
  // merged, so its output is not on my base. `deliveryTitle` / `deliveryId` name
  // the delivery both sides share, so the page can link to it.
  'intent.dependencyPrUnmergedInDelivery': {
    key: 'error.intent.dependencyPrUnmergedInDelivery',
    params: ['title', 'id', 'deliveryTitle', 'deliveryId'],
  },
  // Dependency gate, CROSS delivery: the dependency lives in another delivery that
  // has not reached mainline, so nothing it produced can reach my base yet.
  'intent.dependencyDeliveryNotDelivered': {
    key: 'error.intent.dependencyDeliveryNotDelivered',
    params: ['title', 'id', 'deliveryTitle', 'deliveryId'],
  },
  // A work session must know which delivery it develops against (that is what
  // decides its worktree base and its dependency gate). The intent is linked to
  // several, so the caller must choose — never defaulted.
  'intent.deliveryContextRequired': { key: 'error.intent.deliveryContextRequired' },
  // The named delivery does not exist, or belongs to another workspace.
  'intent.deliveryContextUnknown': { key: 'error.intent.deliveryContextUnknown' },
  // The named delivery exists but the intent is not linked to it.
  'intent.deliveryContextNotLinked': { key: 'error.intent.deliveryContextNotLinked' },
  // Scheduling gate: an associated delivery is closed to new writes
  // (`verifying` / `verified` / `delivered` / `cancelled`).
  'intent.deliveryNotWritable': {
    key: 'error.intent.deliveryNotWritable',
    params: ['deliveryTitle', 'deliveryId', 'status'],
  },
  // The worktree baseline check has NO error code: an existing worktree that does
  // not contain the baseline tip is reported as `intent_worktree_baseline_notice`
  // AFTER the session starts, never as a refusal. It is still never auto-repaired
  // — rebuild and merge stay explicit user actions, and the two codes below are
  // what those actions fail with.
  //
  // Safe rebuild refused at execution time: the worktree holds uncommitted work.
  // Committing or stashing is the user's call; c3 never discards it.
  'intent.worktreeDirty': { key: 'error.intent.worktreeDirty' },
  // A worktree baseline repair (rebuild / merge) failed; the raw git output travels
  // as `message`.
  'intent.worktreeRepairFailed': {
    key: 'error.intent.worktreeRepairFailed',
    params: ['message'],
  },
  // Manual Start-Dev session-end Git/PR cleanup failures (workbench todo copy).
  'intent.gitCleanupNoChanges': { key: 'error.intent.gitCleanupNoChanges' },
  'intent.gitCleanupCommitPushFailed': {
    key: 'error.intent.gitCleanupCommitPushFailed',
    params: ['detail'],
  },
  'intent.gitCleanupGhUnavailable': {
    key: 'error.intent.gitCleanupGhUnavailable',
    params: ['detail'],
  },
  'intent.gitCleanupPrFailed': {
    key: 'error.intent.gitCleanupPrFailed',
    params: ['detail'],
  },
  // The work was committed and pushed, but the PR target could not be resolved
  // (delivery branch not ready, several deliveries linked, delivery unknown or
  // not linked). No PR was created and none was filed against the mainline —
  // which delivery it belongs to is the user's call.
  'intent.gitCleanupPrTargetUnavailable': {
    key: 'error.intent.gitCleanupPrTargetUnavailable',
    params: ['detail'],
  },
  'intent.specAgentUnsupported': { key: 'error.intent.specAgentUnsupported' },
  'intent.specWriteFailed': { key: 'error.intent.specWriteFailed', params: ['message'] },
  'intent.specNotWritten': { key: 'error.intent.specNotWritten' },
  'intent.specNotApproved': { key: 'error.intent.specNotApproved' },
  'intent.specEditForbidden': { key: 'error.intent.specEditForbidden', params: ['status'] },
  'intent.specSessionRunning': { key: 'error.intent.specSessionRunning' },
  // Local park-recovery observation: a failed read is reported as unavailable,
  // never rendered as 0% or an empty sample.
  'intent.parkStatsUnavailable': { key: 'error.intent.parkStatsUnavailable' },
  // agent configuration
  // A session could not be created/bound because the agent GROUP its role points
  // at (directly, or by following the default agent) has no usable member — every
  // member disabled, or that group's vendor runtime is missing on this machine.
  // Reported instead of silently running on some other agent; `group` is the
  // `_c3_<vendor>_<group>` reference the user must fix.
  'agent.groupUnavailable': { key: 'error.agent.groupUnavailable', params: ['group'] },
  // discussion
  'discussion.dbUnavailable': { key: 'error.discussion.dbUnavailable' },
  'discussion.notFound': { key: 'error.discussion.notFound' },
  'discussion.unknown': { key: 'error.discussion.unknown', params: ['id'] },
  'discussion.unknownType': { key: 'error.discussion.unknownType', params: ['type'] },
  'discussion.notConcludable': { key: 'error.discussion.notConcludable' },
  'discussion.alreadyStarted': { key: 'error.discussion.alreadyStarted' },
  'discussion.notEndedForContinue': { key: 'error.discussion.notEndedForContinue' },
  // `cancel_discussion` on a discussion that is already terminal (completed /
  // cancelled): there is nothing left to stop, and flipping the status would
  // rewrite a concluded record.
  'discussion.alreadyEnded': { key: 'error.discussion.alreadyEnded' },
  // delivery (交付作为集成单元, ADR-0036)
  'delivery.dbUnavailable': { key: 'error.delivery.dbUnavailable' },
  'delivery.notFound': { key: 'error.delivery.notFound' },
  'delivery.titleRequired': { key: 'error.delivery.titleRequired' },
  'delivery.createFailed': { key: 'error.delivery.createFailed', params: ['detail'] },
  'delivery.updateFailed': { key: 'error.delivery.updateFailed', params: ['detail'] },
  // A create/update would collide with an active delivery's branch name (the
  // `(workspace_name, branch_name)` uniqueness; terminal deliveries don't hold
  // it). Refused whole rather than silently overwriting. Also the orphan-defense
  // verdict: retrying an init whose remote branch head does NOT match the fetched
  // baseline is a conflict — the remote branch is never overwritten.
  'delivery.branchConflict': { key: 'error.delivery.branchConflict', params: ['branch'] },
  // A multi-repo workspace (root not itself a repo, with sub-repos) cannot host a
  // single delivery branch — it would fake "partially delivered". Rejected at
  // delivery create AND at branch init, before any git command runs.
  'delivery.multiRepoUnsupported': { key: 'error.delivery.multiRepoUnsupported' },
  // `bind` named a remote branch that does not exist.
  'delivery.branchNotFound': { key: 'error.delivery.branchNotFound', params: ['branch'] },
  // Branch init / cleanup failed (fetch/push/local-delete error, or a DB write
  // failure after the push — the retry path idempotently binds the orphan).
  'delivery.initFailed': { key: 'error.delivery.initFailed', params: ['detail'] },
  // 「同步主线」was requested on a delivery that is not `integrating`. Before that
  // there is nothing to integrate; from `verifying` on, changing the tree is
  // exactly what would invalidate the verification.
  'delivery.syncMainlineForbidden': { key: 'error.delivery.syncMainlineForbidden' },
  // The mainline merge stopped on conflicts. Nothing was pushed and c3 picked no
  // resolution — git's own output travels as `detail`.
  'delivery.syncMainlineConflict': {
    key: 'error.delivery.syncMainlineConflict',
    params: ['detail'],
  },
  // The sync failed for any other reason (fetch / push / unresolvable refs).
  'delivery.syncMainlineFailed': { key: 'error.delivery.syncMainlineFailed', params: ['detail'] },
  // Branch cleanup was requested on a non-terminal delivery; only `delivered` /
  // `cancelled` may release their local branch reference.
  'delivery.cleanupForbidden': { key: 'error.delivery.cleanupForbidden' },
  // Delivery PR (「交付分支 → 主线」, the change request a human merges on the forge).
  // The delivery is not `verified`, so there is nothing to propose for mainline
  // yet — verification is what a delivery PR asks the team to merge.
  'delivery.deliveryPrForbidden': { key: 'error.delivery.deliveryPrForbidden' },
  // `current-branch` mode has no delivery branch, so there is no head to open a
  // delivery PR from. The page hides the action; this is the server-side backstop.
  'delivery.deliveryPrModeUnsupported': { key: 'error.delivery.deliveryPrModeUnsupported' },
  // The delivery branch holds nothing mainline does not — typically because it
  // was already merged by hand. Opening an empty PR would only confuse.
  'delivery.deliveryPrNoDiff': { key: 'error.delivery.deliveryPrNoDiff' },
  // Creating the delivery PR failed (refs unresolvable, forge CLI missing / not
  // logged in, push rejected, network). Transient by construction: NOTHING moved,
  // so the same action can simply be retried — the retry asks the forge first and
  // adopts a PR a lost response had already created.
  'delivery.deliveryPrCreateFailed': {
    key: 'error.delivery.deliveryPrCreateFailed',
    params: ['detail'],
  },
  // A sync was requested for a delivery that never opened a delivery PR.
  'delivery.deliveryPrNotFound': { key: 'error.delivery.deliveryPrNotFound' },
  // The forge's live facts could not be read. The delivery status is left exactly
  // as it was — an unreadable forge is not evidence of anything — and the sync is
  // retryable.
  'delivery.deliveryPrSyncFailed': {
    key: 'error.delivery.deliveryPrSyncFailed',
    params: ['detail'],
  },
  // create_pr gate: the intent is associated with a delivery whose branch is not
  // ready, so its PR must not be created yet. Renders through the guard leaf
  // (the same copy the persistent gap list shows).
  'delivery.guard.branchNotReady': { key: 'delivery.guard.branchNotReady' },
  // create_pr target resolution. The request named a delivery that does not
  // exist, or that belongs to another workspace — one code, because from the
  // caller's side both mean "this workspace has no such delivery".
  'delivery.prCreateDeliveryUnknown': { key: 'error.delivery.prCreateDeliveryUnknown' },
  // The named delivery exists, but the intent is not linked to it. Creating the
  // PR anyway would file a PR row under a delivery group the intent never
  // joined, splitting `intent_prs.delivery_id` from `intent_deliveries`.
  'delivery.prCreateNotLinked': { key: 'error.delivery.prCreateNotLinked' },
  // No delivery was named and the intent is linked to several — which one the
  // PR targets is the user's call, never a server guess.
  'delivery.prCreateAmbiguous': { key: 'error.delivery.prCreateAmbiguous' },
  // State-machine rejections (edge not in the graph). Guard-failed rejections
  // carry `delivery.guard.*` reasons on the dedicated `delivery_transition_failed`
  // frame; these two codes drive the toast + error copy.
  'delivery.invalidStatusTransition': {
    key: 'error.delivery.invalidStatusTransition',
    params: ['from', 'to'],
  },
  'delivery.transitionGuardFailed': { key: 'error.delivery.transitionGuardFailed' },
  // Intent ↔ delivery association.
  // The pair is already linked (in-transaction check, unique index as backstop).
  'delivery.intentAlreadyLinked': { key: 'error.delivery.intentAlreadyLinked' },
  // Unlink refused because the intent's PR toward this delivery is MERGED —
  // locally, or live on the forge. Dropping the edge would leave the code on the
  // delivery branch with no association pointing at it; only a revert could undo
  // that, so the unlink is never allowed.
  'delivery.unlinkMergedPrDenied': { key: 'error.delivery.unlinkMergedPrDenied' },
  // Unlink blocked because closing the PR failed. The edge and the PR row are
  // both left untouched — never a half-applied unlink.
  'delivery.unlinkClosePrFailed': {
    key: 'error.delivery.unlinkClosePrFailed',
    params: ['detail'],
  },
  // Unlink blocked because the forge's live PR state could not be read (CLI
  // missing / not logged in / offline). Conservative by design: not being able to
  // rule out "merged" is treated as "may be merged".
  'delivery.unlinkPrStatusCheckFailed': {
    key: 'error.delivery.unlinkPrStatusCheckFailed',
    params: ['detail'],
  },
  // automation
  'automation.dbUnavailable': { key: 'error.automation.dbUnavailable' },
  'automation.notFound': { key: 'error.automation.notFound' },
  'automation.executionNotFound': { key: 'error.automation.executionNotFound' },
  'automation.approvalNotFound': { key: 'error.automation.approvalNotFound' },
  'automation.invalidEventTrigger': { key: 'error.automation.invalidEventTrigger' },
  'automation.invalidMaxWallClockMs': { key: 'error.automation.invalidMaxWallClockMs' },
  'automation.invalidInitialStatus': { key: 'error.automation.invalidInitialStatus' },
  'automation.agentRequired': { key: 'error.automation.agentRequired' },
  'automation.agentNotFound': { key: 'error.automation.agentNotFound' },
  'automation.agentDisabled': { key: 'error.automation.agentDisabled' },
  'automation.agentVendorMismatch': { key: 'error.automation.agentVendorMismatch' },
  'automation.vendorUnsupported': { key: 'error.automation.vendorUnsupported' },
  // wait user involve
  'waitUserInvolve.dbUnavailable': { key: 'error.waitUserInvolve.dbUnavailable' },
  'waitUserInvolve.invalidStatusTransition': {
    key: 'error.waitUserInvolve.invalidStatusTransition',
  },
  // permission mode
  'session.invalidMode': {
    key: 'error.session.invalidMode',
    params: ['vendor', 'mode'],
  },
  // workspace setting
  'workspaceSetting.invalidDefaultMode': {
    key: 'error.workspaceSetting.invalidDefaultMode',
    params: ['vendor', 'mode'],
  },
  // personalized setting
  // Reading or writing the personalized-settings store failed; the client keeps the
  // value it already has (no pseudo-success snapshot, no local fallback wipe).
  'personalizedSetting.loadFailed': { key: 'error.personalizedSetting.loadFailed' },
  'personalizedSetting.saveFailed': { key: 'error.personalizedSetting.saveFailed' },
  // auth (ADR-0023)
  // Rejected a system-config mutation from a non-admin connection (ADR-0023 authz).
  'auth.adminOnly': { key: 'error.auth.adminOnly' },
  // workcenter dashboard
  // Whole-snapshot aggregation failed (a domain db unavailable / a workspace threw).
  'dashboard.loadFailed': { key: 'error.dashboard.loadFailed' },
  // A bulk-gate target workspace is unknown / was removed before the write.
  'dashboard.workspaceMissing': { key: 'error.dashboard.workspaceMissing' },
  // Persisting the automation gate for one workspace failed.
  'dashboard.gateSaveFailed': { key: 'error.dashboard.gateSaveFailed' },
  // automation queue (deterministic scheduling kernel)
  // A per-intent queue control arrived without the intent it applies to.
  'queue.intentRequired': { key: 'error.queue.intentRequired' },
  // Unpark was asked for an intent that is not parked.
  'queue.notParked': { key: 'error.queue.notParked' },
  // An override was asked where there is no automatic verdict to overrule.
  'queue.overrideNotApplicable': { key: 'error.queue.overrideNotApplicable' },
  // external MCP API keys
  // The key id named by an update/revoke no longer exists (already revoked, or
  // deleted by another administrator since the roster was loaded).
  'mcpApiKey.unknown': { key: 'error.mcpApiKey.unknown', params: ['id'] },
  // A key was asked to bind a workspace name c3 does not have (or that no longer
  // resolves). The binding is fixed at creation, so this is refused outright
  // rather than falling back to some other workspace.
  'mcpApiKey.unknownWorkspace': {
    key: 'error.mcpApiKey.unknownWorkspace',
    params: ['workspaceName'],
  },
  // A tool scope named something outside the server's externally-grantable
  // catalog (or repeated a name). Rejected whole rather than partially applied,
  // so a half-saved scope never looks like the one that was submitted.
  'mcpApiKey.unknownTool': { key: 'error.mcpApiKey.unknownTool', params: ['tool'] },
  // Persisting the key roster failed (settings.json unwritable / lock contention).
  'mcpApiKey.saveFailed': { key: 'error.mcpApiKey.saveFailed' },
  // A self-service key operation arrived on a connection with no resolvable
  // identity. There is no owner to file the key under, and picking one would be
  // minting a credential nobody asked for — so it is refused rather than guessed.
  'mcpApiKey.noIdentity': { key: 'error.mcpApiKey.noIdentity' },
  // account × workspace access editor
  // The subject named by a save is not a current non-admin account (removed since
  // the roster loaded, or never existed).
  'userAccess.unknownAccount': { key: 'error.userAccess.unknownAccount', params: ['subject'] },
  // A selected workspace name is not in the live registry. The whole save is
  // refused rather than silently dropping the name, so what was saved is always
  // exactly what was submitted.
  'userAccess.unknownWorkspace': {
    key: 'error.userAccess.unknownWorkspace',
    params: ['workspaceName'],
  },
  // A save named a scope mode c3 cannot interpret. Never guessed at: one guess
  // would silently narrow the account's access, the other silently widen it.
  'userAccess.invalidMode': { key: 'error.userAccess.invalidMode' },
  // Refused to write a policy row for the configured administrator or the
  // synthesized `local` identity: both hold an implicit `all` scope that exists as
  // a resolver branch, and storing one would let an administrator lock themselves out.
  'userAccess.immutableSubject': { key: 'error.userAccess.immutableSubject', params: ['subject'] },
  // Persisting the policy failed. Neither the policy nor the epoch moved, and no
  // session was closed.
  'userAccess.saveFailed': { key: 'error.userAccess.saveFailed' },
  // The accessor list was asked for a workspace the caller cannot reach — which
  // covers "no such workspace" too, deliberately using ONE code so the read
  // cannot be used to probe which workspace names exist.
  'workspaceAccessors.forbidden': { key: 'error.workspaceAccessors.forbidden' },
} as const satisfies Record<string, UiErrorDef>

/** Every registered UI error code. */
export type UiErrorCode = keyof typeof UI_ERROR_CODES

/**
 * Machine-readable error payload sent server → web. `params` carries values for
 * the target key's placeholders (e.g. `{ detail }`); values may be English
 * technical detail (exception text) — that is debug data, not UI copy.
 */
export interface UiError {
  code: UiErrorCode
  params?: Record<string, string | number>
  /**
   * Optional targeted repair guidance for a failed Git / forge action — only
   * ever set by the worktree-create and PR-create chains. Purely additive: a
   * client that does not know the field still renders `code` + `params` exactly
   * as before, and a client that cannot validate it falls back to the same.
   */
  guidance?: GitActionFailureGuidance
}
