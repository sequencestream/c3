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
  'intent.cannotStartDev': { key: 'error.intent.cannotStartDev', params: ['status'] },
  'intent.devStartInFlight': { key: 'error.intent.devStartInFlight' },
  'intent.illegalStatusTransition': {
    key: 'error.intent.illegalStatusTransition',
    params: ['from', 'to'],
  },
  'intent.prCreateFailed': {
    key: 'error.intent.prCreateFailed',
    params: ['detail'],
  },
  'intent.worktreeCreateFailed': {
    key: 'error.intent.worktreeCreateFailed',
    params: ['message'],
  },
  'intent.dependencyNotMerged': {
    key: 'error.intent.dependencyNotMerged',
    params: ['title', 'id'],
  },
  // discussion
  'discussion.dbUnavailable': { key: 'error.discussion.dbUnavailable' },
  'discussion.notFound': { key: 'error.discussion.notFound' },
  'discussion.unknown': { key: 'error.discussion.unknown', params: ['id'] },
  'discussion.unknownType': { key: 'error.discussion.unknownType', params: ['type'] },
  'discussion.notConcludable': { key: 'error.discussion.notConcludable' },
  'discussion.alreadyStarted': { key: 'error.discussion.alreadyStarted' },
  'discussion.notEndedForContinue': { key: 'error.discussion.notEndedForContinue' },
  // schedule
  'schedule.dbUnavailable': { key: 'error.schedule.dbUnavailable' },
  'schedule.notFound': { key: 'error.schedule.notFound' },
  'schedule.executionNotFound': { key: 'error.schedule.executionNotFound' },
  'schedule.approvalNotFound': { key: 'error.schedule.approvalNotFound' },
  'schedule.invalidEventTrigger': { key: 'error.schedule.invalidEventTrigger' },
  // wait user involve
  'waitUserInvolve.dbUnavailable': { key: 'error.waitUserInvolve.dbUnavailable' },
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
  'auth.oauthAdminInvalid': { key: 'error.auth.oauthAdminInvalid' },
  // Rejected a system-config mutation from a non-admin connection (ADR-0023 authz).
  'auth.adminOnly': { key: 'error.auth.adminOnly' },
  // product-license (ADR-0026): new-session creation refused while not entitled
  // (PL-R6). `reason` carries the entitlement state
  // (`unactivated`/`expired`/`disabled`) so the web can localize the cause; the
  // web special-cases this code to render a localized reason phrase + a renewal
  // pointer to the license badge.
  'license.notEntitled': { key: 'error.license.notEntitled', params: ['reason'] },
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
