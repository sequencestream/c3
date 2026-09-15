/**
 * Model-provider SPEED TEST — the performance-observation contract, deliberately
 * separate from the connectivity probe next door in `model-provider.ts`.
 *
 * The probe answers "does this endpoint answer at all" with a bare GET; its
 * `latencyMs` is a TCP+TLS+HTTP round trip and says nothing about the model. A
 * speed test answers "how fast does this endpoint produce tokens" by issuing REAL
 * streaming generations with the provider's stored account key, and leaves a
 * durable, append-only record behind. The two never share a number.
 *
 * Everything here is the CALIBRATED form of that question. One fixed short prompt,
 * temperature 0, a fixed output ceiling, concurrency 1 — so two runs against two
 * providers, or the same provider a month apart, are comparable. What it therefore
 * does NOT measure: long context, long output, reasoning chains, and behaviour
 * under concurrency.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 * Zero-runtime wire module: no zod, no vendor SDK. Message payloads live in
 * `./model-provider-speed-test-messages.ts` and are NOT re-exported.
 */

import type { ProtocolType } from './model-provider.js'

// ---- Calibration ----

/**
 * The calibration this build issues. Stored on every run so a record made under a
 * different report body is never averaged together with today's — bumping this
 * string is how a future change to the prompt or the parameters stays honest
 * instead of silently rewriting history.
 */
export const SPEED_TEST_CALIBRATION_VERSION = 'chat-short-v1'

/**
 * The single user message every request carries. Short, deterministic, and
 * output-bound: it asks for a bounded stream of cheap tokens so the measurement is
 * dominated by the endpoint rather than by how hard the model is thinking. Not
 * editable — an editable prompt would make two runs incomparable, which is the one
 * property this capability exists to provide.
 */
export const SPEED_TEST_PROMPT =
  'Count from 1 to 100, separated by commas. Output only the numbers.'

/** Output ceiling for one request (`max_tokens` / `max_output_tokens`). */
export const SPEED_TEST_MAX_OUTPUT_TOKENS = 128

/** Sampling temperature. Zero: the same endpoint should not vary run to run by luck. */
export const SPEED_TEST_TEMPERATURE = 0

/** Per-request budget, from "about to dial" to "stream finished" (ms). */
export const SPEED_TEST_REQUEST_TIMEOUT_MS = 60_000

/** Requests per run, when the dialog is opened. */
export const SPEED_TEST_DEFAULT_REQUESTS = 10

/** Fewest requests a run may plan. */
export const SPEED_TEST_MIN_REQUESTS = 1

/**
 * Most requests a run may plan. A ceiling, not a recommendation: every request is
 * billed upstream, and they are issued serially, so 100 × a slow endpoint is a long
 * wait the operator pays for twice.
 */
export const SPEED_TEST_MAX_REQUESTS = 100

/** Report page size for one provider's history. */
export const SPEED_TEST_HISTORY_PAGE_SIZE = 20

/**
 * How many of a provider's newest runs the comparison view offers to switch
 * between.
 *
 * The whole point of the comparison is the side-by-side summary, so each
 * provider's recent runs travel WITH the comparison rather than behind a second
 * round trip: switching a row's record must re-render — and re-sort — without a
 * network wait. That is only affordable while the payload stays bounded, hence a
 * limit. It is a ceiling on CHOICES, not on history: `runCount` still reports the
 * full total, and older runs stay reachable in the single-provider report.
 */
export const SPEED_TEST_COMPARE_CHOICE_LIMIT = 10

// ---- Closed sets ----

/**
 * Which upstream API the run actually spoke. DERIVED server-side from the saved
 * provider (protocol slot + `wireApi`), never chosen in the dialog — the point is
 * to measure the endpoint an agent would really use.
 *
 *  - `chat`      — OpenAI Chat Completions (`openai` slot, `wireApi` `chat`/absent).
 *  - `responses` — OpenAI Responses (`openai` slot, `wireApi: 'responses'`).
 *  - `messages`  — Anthropic Messages (`anthropic` slot; `wireApi` is not consulted).
 */
export type SpeedTestApiDialect = 'chat' | 'responses' | 'messages'

/** Runtime list of every {@link SpeedTestApiDialect}; pinned against the union. */
export const SPEED_TEST_API_DIALECTS = [
  'chat',
  'responses',
  'messages',
] as const satisfies readonly SpeedTestApiDialect[]

/** How one request ended. */
export type SpeedTestRequestOutcome = 'success' | 'failure' | 'cancelled'

/** Runtime list of every {@link SpeedTestRequestOutcome}. */
export const SPEED_TEST_REQUEST_OUTCOMES = [
  'success',
  'failure',
  'cancelled',
] as const satisfies readonly SpeedTestRequestOutcome[]

/**
 * Why a request failed. Diagnostic grouping only — none of these arms asserts
 * whose fault it was; "the network is slow" and "the vendor is slow" are
 * conclusions a human draws from the pattern, never claims this record makes.
 *
 *  - `timeout` — the per-request budget elapsed before the stream finished.
 *  - `http`    — the endpoint answered with a non-2xx status (kept in `httpStatus`),
 *                including 3xx, which is refused rather than followed.
 *  - `network` — the connection never produced a usable HTTP response.
 *  - `stream`  — HTTP was fine but the stream was not: an in-band error event,
 *                malformed SSE, a missing terminator, or zero text produced.
 */
export type SpeedTestFailureCategory = 'timeout' | 'http' | 'network' | 'stream'

/** Runtime list of every {@link SpeedTestFailureCategory}. */
export const SPEED_TEST_FAILURE_CATEGORIES = [
  'timeout',
  'http',
  'network',
  'stream',
] as const satisfies readonly SpeedTestFailureCategory[]

/**
 * Where `outputTokens` came from.
 *
 *  - `usage`          — the protocol's terminal usage block. Authoritative.
 *  - `delta_estimate` — the upstream sent no usage, so non-empty text delta EVENTS
 *                       were counted. One event may carry several tokens, so this
 *                       is a LOWER bound with unbounded error, which is why every
 *                       surface that shows a TPOT or a tokens/sec derived from it
 *                       says so rather than implying billing parity.
 */
export type SpeedTestTokenCountSource = 'usage' | 'delta_estimate'

/** Runtime list of every {@link SpeedTestTokenCountSource}. */
export const SPEED_TEST_TOKEN_COUNT_SOURCES = [
  'usage',
  'delta_estimate',
] as const satisfies readonly SpeedTestTokenCountSource[]

/**
 * How the run as a whole ended.
 *
 *  - `completed`   — all planned requests were issued and at least one succeeded.
 *                    Does NOT mean all succeeded; read `failureCount` too.
 *  - `failed`      — all planned requests were issued and every one failed.
 *  - `interrupted` — the operator stopped it before the plan was exhausted.
 */
export type SpeedTestOutcome = 'completed' | 'failed' | 'interrupted'

/** Runtime list of every {@link SpeedTestOutcome}. */
export const SPEED_TEST_OUTCOMES = [
  'completed',
  'failed',
  'interrupted',
] as const satisfies readonly SpeedTestOutcome[]

/**
 * Why the server refused, or could not finish, an operation. Structured so the
 * console can render a localized sentence; upstream response bodies never travel
 * in these frames, because they can echo a key back.
 *
 *  - `invalid_count`        — request count outside {@link SPEED_TEST_MIN_REQUESTS}..{@link SPEED_TEST_MAX_REQUESTS},
 *                             or not an integer.
 *  - `provider_unknown`     — no SAVED provider carries that id (a draft cannot be tested).
 *  - `protocol_unavailable` — the chosen protocol slot is absent or blank on the saved config.
 *  - `invalid_url`          — the chosen slot's URL fails `checkProviderBaseUrl` at `error` severity.
 *  - `models_empty`         — the provider's merged model catalog is empty.
 *  - `model_unavailable`    — the chosen model is blank or absent from that catalog.
 *  - `busy`                 — this provider already has a run in flight (`runId` names it).
 *  - `not_found`            — no such run / no active run to act on.
 *  - `db_unavailable`       — the database cannot be reached, so a run must not start:
 *                             spending the operator's credits and then dropping the
 *                             record is worse than refusing.
 *  - `save_failed`          — the run finished but its transaction did not commit. The
 *                             in-memory result survives for a `retry_save`.
 */
export type SpeedTestErrorCode =
  | 'invalid_count'
  | 'provider_unknown'
  | 'protocol_unavailable'
  | 'invalid_url'
  | 'models_empty'
  | 'model_unavailable'
  | 'busy'
  | 'not_found'
  | 'db_unavailable'
  | 'save_failed'

/**
 * Coarse grouping of {@link SpeedTestErrorCode}, so the console can decide whether
 * to re-validate the form, offer a retry, or just report.
 */
export type SpeedTestErrorCategory = 'validation' | 'conflict' | 'storage' | 'not_found'

/** Which category each error code belongs to. Single source for both ends. */
export const SPEED_TEST_ERROR_CATEGORIES = {
  invalid_count: 'validation',
  provider_unknown: 'validation',
  protocol_unavailable: 'validation',
  invalid_url: 'validation',
  models_empty: 'validation',
  model_unavailable: 'validation',
  busy: 'conflict',
  not_found: 'not_found',
  db_unavailable: 'storage',
  save_failed: 'storage',
} as const satisfies Record<SpeedTestErrorCode, SpeedTestErrorCategory>

// ---- Per-request sample ----

/**
 * One issued request, as recorded. Durations come from the server's MONOTONIC
 * clock in milliseconds and cover dialing through stream termination only — queue
 * wait, database write and websocket push are outside the measurement.
 *
 * A failed request keeps whatever it managed to observe (`ttftMs` may be set if
 * text arrived before the stream broke); those observations are shown in the
 * detail table but are excluded from every aggregate latency statistic.
 */
export interface SpeedTestRequestRecord {
  /** 1-based position in the run; unique within it. */
  sequence: number
  /** Wall-clock epoch ms when this request was dialed (for the detail table only). */
  startedAt: number
  outcome: SpeedTestRequestOutcome
  /** Set only when `outcome === 'failure'`. */
  failureCategory: SpeedTestFailureCategory | null
  /** HTTP status, when the endpoint answered with one. */
  httpStatus: number | null
  /**
   * Time to first token: dial → arrival of the first text delta whose string is
   * non-empty (a single space counts; role, heartbeat and usage-only events do
   * not). `null` when no text ever arrived.
   */
  ttftMs: number | null
  /** Dial → stream termination (or failure). `null` only for `cancelled`. */
  endToEndMs: number | null
  /** Output tokens produced; see {@link tokenCountSource}. */
  outputTokens: number | null
  tokenCountSource: SpeedTestTokenCountSource | null
  /**
   * Time per output token: `(endToEndMs - ttftMs) / (outputTokens - 1)`.
   *
   * Defined only for a SUCCESSFUL request with `outputTokens >= 2` — the first
   * token's cost is TTFT, so dividing by `outputTokens` would double-count it, and
   * a single-token response has no inter-token interval at all. `null` otherwise.
   */
  tpotMs: number | null
}

// ---- Aggregates ----

/**
 * One latency metric's distribution across the run's eligible samples.
 *
 * Only SUCCESSFUL requests contribute, and only those whose value is non-null
 * (so `tpot` typically has fewer samples than `ttft`). `avgMs` is the arithmetic
 * mean. Percentiles use NEAREST-RANK with no interpolation: over the ascending
 * sample array of length `m`, `Pp = x[ceil(p * m) - 1]`. With the default 10
 * samples, P95 and P99 both land on the maximum — the report shows `sampleCount`
 * precisely so that is visible rather than mistaken for a tail estimate.
 *
 * All four values are `null` when `sampleCount === 0`. Values are unrounded;
 * rounding happens at display time only.
 */
export interface SpeedTestLatencyStats {
  sampleCount: number
  avgMs: number | null
  p50Ms: number | null
  p95Ms: number | null
  p99Ms: number | null
}

/**
 * The whole-run aggregate.
 *
 * Counting rule: `completedCount = successCount + failureCount`. A `cancelled`
 * request — one aborted in flight by the operator — is neither, so it never moves
 * the success rate and never enters a sample set; requests that were planned but
 * never dialed are not recorded at all.
 */
export interface SpeedTestSummary {
  /** Requests that reached a natural end (success or failure). */
  completedCount: number
  successCount: number
  failureCount: number
  /** In-flight requests aborted by an interrupt. Reported, never scored. */
  cancelledCount: number
  /**
   * `successCount / completedCount`, in 0..1. `null` when nothing completed.
   * After an interrupt this describes the completed part only, which is why the
   * report shows "n completed / N planned" beside it.
   */
  successRate: number | null
  ttft: SpeedTestLatencyStats
  tpot: SpeedTestLatencyStats
  endToEnd: SpeedTestLatencyStats
  /** Σ `endToEndMs` over successful requests — the throughput denominator. */
  successfulWallTimeMs: number
  /** Σ `outputTokens` over successful requests. */
  outputTokensTotal: number
  /**
   * `outputTokensTotal / (successfulWallTimeMs / 1000)`. `null` when there were no
   * successes or the accumulated time is 0 (never `Infinity`/`NaN`).
   *
   * Serial-run semantics: the denominator is the time successful requests OCCUPIED,
   * excluding failures, cancellations and the gaps between requests. It is not the
   * run's real elapsed time and is not a service capacity ceiling.
   */
  tokensPerSecond: number | null
  /** `successCount / (successfulWallTimeMs / 1000)`; same denominator and caveats. */
  requestsPerSecond: number | null
  /**
   * How many successful samples counted tokens by `delta_estimate`. Non-zero ⇒ the
   * console marks TPOT and tokens/sec as containing estimates.
   */
  estimatedSampleCount: number
}

// ---- Persisted run ----

/**
 * One finished run's head record. Append-only: written once, in the same
 * transaction as its request details, and never updated or deleted afterwards.
 *
 * `providerId` is a WEAK reference — no foreign key, no cascade. The display name
 * is snapshotted at start so a record stays readable after the provider is renamed
 * or removed, and a renamed provider never rewrites its own history.
 */
export interface SpeedTestRun {
  /** Unique run id; also the key progress, interrupts and the report use. */
  runId: string
  providerId: string
  /** Display name AS IT WAS when the run started. */
  providerDisplayName: string
  /** Epoch ms the run started. */
  startedAt: number
  /** Epoch ms the run was sealed. */
  finishedAt: number
  /** How many requests the operator asked for. */
  plannedCount: number
  /** Which protocol slot supplied the endpoint. */
  protocolType: ProtocolType
  /** Which upstream API was actually spoken. */
  apiDialect: SpeedTestApiDialect
  model: string
  /** {@link SPEED_TEST_CALIBRATION_VERSION} as of the run. */
  calibrationVersion: string
  /** The fixed parameters this calibration used, snapshotted for readability. */
  maxOutputTokens: number
  temperature: number
  outcome: SpeedTestOutcome
  summary: SpeedTestSummary
}

/** A run plus its per-request details, ordered by `sequence`. */
export interface SpeedTestRunDetail {
  run: SpeedTestRun
  requests: SpeedTestRequestRecord[]
}

/** One page of a provider's history, newest first by `(startedAt, runId)`. */
export interface SpeedTestHistoryPage {
  providerId: string
  runs: SpeedTestRun[]
  /** Whether another page exists after this one. */
  hasMore: boolean
}

/**
 * One entry of the "which providers have history" picker. Present is `false` when
 * the id no longer matches a saved provider — those stay listed, because dropping
 * them is what would make the history unreachable.
 */
export interface SpeedTestHistoryProvider {
  providerId: string
  /** Current provider name when it still exists, else the newest snapshot. */
  displayName: string
  runCount: number
  /** `startedAt` of the newest run. */
  lastStartedAt: number
  present: boolean
}

// ---- Cross-provider comparison ----

/**
 * One provider's column in the side-by-side view: who it is, and the runs the
 * operator may choose between for it.
 *
 * Present is `false` when the id no longer matches a saved provider — those stay
 * listed, because dropping them is what would make the record unreachable.
 *
 * `runs` is newest-first and never empty (a provider reaches this list only by
 * having a run), and holds at most {@link SPEED_TEST_COMPARE_CHOICE_LIMIT} entries
 * while `runCount` reports the true total. Each run carries its own frozen target
 * and summary, so the row can show — and the client can sort by — values measured
 * at different moments against possibly different models without a second fetch.
 *
 * Nothing here is a new measurement: an entry is a projection of stored runs, and
 * no summary is recomputed or averaged across runs. That is deliberate. Two
 * providers are never measured at the same instant, so the honest shape of this
 * data is "here is each one's most recent reading", never a merged ranking.
 */
export interface SpeedTestComparisonEntry {
  providerId: string
  /** Current provider name when it still exists, else the newest snapshot. */
  displayName: string
  present: boolean
  /** Total runs on record, including any older than `runs`. */
  runCount: number
  /** Newest first; at least one, at most {@link SPEED_TEST_COMPARE_CHOICE_LIMIT}. */
  runs: SpeedTestRun[]
}

// ---- Live run ----

/**
 * The state of a run the server is currently holding. Survives the dialog being
 * closed, the page being navigated away from, and the socket dropping — only an
 * explicit interrupt stops the upstream calls, so reconnecting re-attaches instead
 * of starting a second run.
 *
 * `save_failed` is the one non-running state that lingers: the sampling is over
 * but the transaction did not commit, so the result is held in this process for a
 * `retry_save` rather than being lost silently after real money was spent. It
 * travels BOTH ways — as this snapshot on the `active` answer and on the
 * `save_failed` error — precisely so a console that was not looking when the
 * commit failed can still find the retry: `active` is asked again every time the
 * dialog opens, and it is the server, not a remembered frame, that decides
 * whether there is something left to save.
 */
export interface SpeedTestActiveRun {
  runId: string
  providerId: string
  providerDisplayName: string
  protocolType: ProtocolType
  apiDialect: SpeedTestApiDialect
  model: string
  plannedCount: number
  /** `successCount + failureCount`; cancelled requests do not advance it. */
  completedCount: number
  successCount: number
  failureCount: number
  startedAt: number
  state: 'running' | 'save_failed'
}
