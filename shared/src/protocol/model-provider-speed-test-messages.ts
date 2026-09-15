/**
 * Speed-test message payloads. Internal to the protocol partition — never
 * re-exported by `../protocol.ts`, which lists exactly the two top-level types
 * below as union arms.
 *
 * Two frames carry the whole capability, each a discriminated union:
 * `model_provider_speed_test` (C→S, keyed by `action`) and
 * `model_provider_speed_test_result` (S→C, keyed by `event`). One frame per
 * direction rather than fourteen top-level types keeps the two big unions
 * readable; the inner discriminant keeps each branch exactly as narrow as a
 * dedicated message would be — no arm carries a field another arm ignores.
 *
 * Two correlation ids, on purpose:
 *  - `requestId` ties ONE request to ONE reply, so a console with several panels
 *    open can match answers.
 *  - `runId` names an EXECUTION, and outlives the request that started it —
 *    progress, interrupt, reconnect-and-reattach, and the saved history record
 *    all address the same run by it.
 *
 * `start` deliberately accepts no URL, key, dialect or report body: every one of
 * those is read from the SAVED provider server-side. A client that could name an
 * endpoint would be a way to point an account-level key at an arbitrary host.
 */

import type { ProtocolType } from './model-provider.js'
import type {
  SpeedTestActiveRun,
  SpeedTestErrorCode,
  SpeedTestHistoryPage,
  SpeedTestHistoryProvider,
  SpeedTestRun,
  SpeedTestRunDetail,
} from './model-provider-speed-test.js'

/** Fields shared by every C→S arm. */
type SpeedTestRequestBase = {
  type: 'model_provider_speed_test'
  /** Correlates this request with its single reply. */
  requestId: string
}

/**
 * Begin a run against a SAVED provider. The server derives the endpoint, the API
 * dialect and the credential from its own copy of the configuration; an unsaved
 * draft therefore cannot be measured, which is what keeps a recorded number
 * attributable to a configuration that actually exists.
 */
type SpeedTestStart = SpeedTestRequestBase & {
  action: 'start'
  providerId: string
  /** Which saved protocol slot to dial. */
  protocolType: ProtocolType
  /** Model id, which must be in the provider's merged catalog. */
  model: string
  /** How many requests to issue, serially. */
  requestCount: number
}

/** Stop the named run now: no further requests are dialed, the in-flight one aborts. */
type SpeedTestInterrupt = SpeedTestRequestBase & { action: 'interrupt'; runId: string }

/** Ask whether this provider has a run in flight — how a reopened dialog re-attaches. */
type SpeedTestActive = SpeedTestRequestBase & { action: 'active'; providerId: string }

/**
 * Re-attempt the commit for a finished run whose transaction failed. Replays
 * nothing upstream: the samples are already in memory, so this costs no credits
 * and a duplicate `runId` cannot insert a second history entry.
 */
type SpeedTestRetrySave = SpeedTestRequestBase & { action: 'retry_save'; runId: string }

/** One page of a provider's history, newest first. */
type SpeedTestList = SpeedTestRequestBase & {
  action: 'list'
  providerId: string
  /** Rows to skip; omitted ⇒ 0. */
  offset?: number
}

/** One run's full summary plus its per-request details. */
type SpeedTestDetail = SpeedTestRequestBase & { action: 'detail'; runId: string }

/** Every provider id that has history, including ones no longer configured. */
type SpeedTestHistoryProviders = SpeedTestRequestBase & { action: 'history_providers' }

/** Client → server speed-test frame. */
export type ClientModelProviderSpeedTest =
  | SpeedTestStart
  | SpeedTestInterrupt
  | SpeedTestActive
  | SpeedTestRetrySave
  | SpeedTestList
  | SpeedTestDetail
  | SpeedTestHistoryProviders

/** Fields shared by every S→C arm. */
type SpeedTestResultBase = {
  type: 'model_provider_speed_test_result'
  /** Echo of the originating request's id; absent on unsolicited progress. */
  requestId?: string
}

/**
 * The run was validated and is now executing. Carries the server-derived facts
 * the dialog could not know — above all `apiDialect`, which the client never
 * supplies.
 */
type SpeedTestAccepted = SpeedTestResultBase & { event: 'accepted'; run: SpeedTestActiveRun }

/**
 * One request reached a natural end. Pushed without a `requestId`, because the
 * run outlives the request that started it. Deliberately counts only — the detail
 * rows travel once, with the report, rather than on every tick.
 */
type SpeedTestProgress = SpeedTestResultBase & { event: 'progress'; run: SpeedTestActiveRun }

/**
 * The run is over. Sent only AFTER the history transaction commits, so "finished"
 * and "saved" are never two different truths. A commit failure arrives as an
 * `error` with `save_failed` instead.
 */
type SpeedTestFinished = SpeedTestResultBase & { event: 'finished'; detail: SpeedTestRunDetail }

/** Answer to `active`: the run in flight for that provider, or `null`. */
type SpeedTestActiveReply = SpeedTestResultBase & {
  event: 'active'
  providerId: string
  run: SpeedTestActiveRun | null
}

/** Answer to `list`. */
type SpeedTestListReply = SpeedTestResultBase & { event: 'list'; page: SpeedTestHistoryPage }

/** Answer to `detail`. */
type SpeedTestDetailReply = SpeedTestResultBase & { event: 'detail'; detail: SpeedTestRunDetail }

/** Answer to `history_providers`. */
type SpeedTestHistoryProvidersReply = SpeedTestResultBase & {
  event: 'history_providers'
  providers: SpeedTestHistoryProvider[]
}

/**
 * A refusal or a failure. `code` is machine-readable and localized by the console;
 * no upstream response body is ever forwarded, because one can echo a key back.
 */
type SpeedTestError = SpeedTestResultBase & {
  event: 'error'
  code: SpeedTestErrorCode
  /** The provider the request concerned, when it named one. */
  providerId?: string
  /** For `busy`: the run already in flight. For `save_failed`: the unsaved run. */
  runId?: string
  /** For `save_failed`: the result held in memory, so the dialog can still show it. */
  run?: SpeedTestRun
}

/** Server → client speed-test frame. */
export type ServerModelProviderSpeedTestResult =
  | SpeedTestAccepted
  | SpeedTestProgress
  | SpeedTestFinished
  | SpeedTestActiveReply
  | SpeedTestListReply
  | SpeedTestDetailReply
  | SpeedTestHistoryProvidersReply
  | SpeedTestError
