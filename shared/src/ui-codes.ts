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
  'path.notDirectory': { key: 'error.path.notDirectory', params: ['path'] },
  'command.listFailed': { key: 'error.command.listFailed', params: ['detail'] },
  // codes
  'codes.invalidPath': { key: 'error.codes.invalidPath', params: ['path'] },
  'codes.notDirectory': { key: 'error.codes.notDirectory', params: ['path'] },
  'codes.notFile': { key: 'error.codes.notFile', params: ['path'] },
  'codes.readFailed': { key: 'error.codes.readFailed', params: ['path'] },
  'codes.searchFailed': { key: 'error.codes.searchFailed' },
  // session
  'session.listFailed': { key: 'error.session.listFailed', params: ['detail'] },
  'session.openFailed': { key: 'error.session.openFailed', params: ['detail'] },
  'session.deleteFailed': { key: 'error.session.deleteFailed', params: ['detail'] },
  'session.renameFailed': { key: 'error.session.renameFailed', params: ['detail'] },
  'session.notSelected': { key: 'error.session.notSelected' },
  'session.turnRunning': { key: 'error.session.turnRunning' },
  // prompt input
  'prompt.unsupportedFile': { key: 'error.prompt.unsupportedFile', params: ['mediaType'] },
  // intent
  'intent.notFound': { key: 'error.intent.notFound' },
  'intent.dbUnavailable': { key: 'error.intent.dbUnavailable' },
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
  'intent.createFailed': { key: 'error.intent.createFailed', params: ['detail'] },
  'intent.startSessionFailed': { key: 'error.intent.startSessionFailed', params: ['detail'] },
  'intent.sessionAlreadyBound': { key: 'error.intent.sessionAlreadyBound' },
  'intent.deleteForbidden': { key: 'error.intent.deleteForbidden', params: ['detail'] },
  'intent.cannotStartDev': { key: 'error.intent.cannotStartDev', params: ['status'] },
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
  'intent.dependencyNotMerged': {
    key: 'error.intent.dependencyNotMerged',
    params: ['title', 'id'],
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
  'intent.specAgentUnsupported': { key: 'error.intent.specAgentUnsupported' },
  'intent.specWriteFailed': { key: 'error.intent.specWriteFailed', params: ['message'] },
  'intent.specNotWritten': { key: 'error.intent.specNotWritten' },
  'intent.specNotApproved': { key: 'error.intent.specNotApproved' },
  'intent.specEditForbidden': { key: 'error.intent.specEditForbidden', params: ['status'] },
  'intent.specSessionRunning': { key: 'error.intent.specSessionRunning' },
  // discussion
  'discussion.dbUnavailable': { key: 'error.discussion.dbUnavailable' },
  'discussion.notFound': { key: 'error.discussion.notFound' },
  'discussion.unknown': { key: 'error.discussion.unknown', params: ['id'] },
  'discussion.unknownType': { key: 'error.discussion.unknownType', params: ['type'] },
  'discussion.notConcludable': { key: 'error.discussion.notConcludable' },
  'discussion.alreadyStarted': { key: 'error.discussion.alreadyStarted' },
  'discussion.notEndedForContinue': { key: 'error.discussion.notEndedForContinue' },
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
}
