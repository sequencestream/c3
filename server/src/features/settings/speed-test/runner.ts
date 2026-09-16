/**
 * The sampling executor: issues one run's requests and turns each stream into a
 * measured sample.
 *
 * Serial by construction — the next request is dialed only after the previous one
 * has fully collapsed. One in-flight request at a time is what makes two runs
 * comparable at all; it is also why this cannot answer anything about concurrency,
 * and why a 100-request run against a slow endpoint is a long wait the operator is
 * paying for. No warm-up, no retry, no top-up for a failed sample, no parameter
 * downgrade: a normal run issues exactly N requests and a failure just moves on.
 *
 * The upstream is dialed DIRECTLY, never through the relay. The relay exists to
 * keep a real key away from a vendor subprocess and to fail over between
 * candidates — both of which would put a proxy hop and a possible silent provider
 * switch inside the number being measured.
 *
 * Nothing that leaves this module can carry a credential: the key lives in a local
 * header object, generated text is counted and dropped, and upstream error bodies
 * are never read into a record — only the status code is.
 *
 * `fetch` and both clocks are injected so tests drive scripted SSE streams with no
 * network and no real time.
 */
import {
  SPEED_TEST_REQUEST_TIMEOUT_MS,
  type ProtocolType,
  type SpeedTestApiDialect,
  type SpeedTestFailureCategory,
  type SpeedTestOutcome,
  type SpeedTestRequestRecord,
} from '@ccc/shared/protocol'
import { buildRequest, createStreamReader } from './dialects.js'
import { SseDataReader } from './sse.js'
import { computeTpotMs } from './stats.js'

/** The frozen target of one run. Captured at start; later config edits cannot move it. */
export interface SpeedTestPlan {
  runId: string
  providerId: string
  /** Provider name as it was at start — snapshotted into the history record. */
  providerDisplayName: string
  protocolType: ProtocolType
  apiDialect: SpeedTestApiDialect
  model: string
  plannedCount: number
  /** The saved slot's base URL, already structurally checked. */
  baseUrl: string
  /** The saved account-level key. Never leaves this process. */
  apiKey: string
}

/** Injected environment, so tests need neither a network nor a wall clock. */
export interface SpeedTestDeps {
  fetch: typeof globalThis.fetch
  /** Monotonic milliseconds — durations only. */
  now: () => number
  /** Epoch milliseconds — timestamps only. */
  wallClock: () => number
  /** Per-request budget; overridable so tests do not wait a minute. */
  timeoutMs?: number
}

/** Counts a progress push needs. Cancelled requests are absent by design. */
export interface SpeedTestProgressCounts {
  completedCount: number
  successCount: number
  failureCount: number
}

/** One request's outcome before it is folded into a record. */
interface Sample {
  outcome: SpeedTestRequestRecord['outcome']
  failureCategory: SpeedTestFailureCategory | null
  httpStatus: number | null
  observedModel: string | null
  ttftMs: number | null
  endToEndMs: number | null
  outputTokens: number | null
  tokenCountSource: SpeedTestRequestRecord['tokenCountSource']
}

/**
 * One run in flight. Constructed per start, discarded once its records are sealed;
 * the caller owns persistence, because a run that is still mutating has no business
 * touching an append-only table.
 */
export class SpeedTestExecution {
  /** Naturally completed and cancelled requests, in issue order. */
  readonly records: SpeedTestRequestRecord[] = []
  readonly startedAt: number

  private interrupted = false
  private inFlight: AbortController | null = null
  private finished = false

  constructor(
    readonly plan: SpeedTestPlan,
    private readonly deps: SpeedTestDeps,
    /** Called after each request that reached a natural end. Never for a cancel. */
    private readonly onProgress: (counts: SpeedTestProgressCounts) => void = () => {},
  ) {
    this.startedAt = deps.wallClock()
  }

  get successCount(): number {
    return this.records.filter((r) => r.outcome === 'success').length
  }

  get failureCount(): number {
    return this.records.filter((r) => r.outcome === 'failure').length
  }

  /** `successCount + failureCount`; a cancelled request never advances it. */
  get completedCount(): number {
    return this.successCount + this.failureCount
  }

  /**
   * Stop now: no further requests are dialed and the in-flight one is aborted, so
   * it lands as `cancelled` rather than as a failure the provider did not cause.
   * Idempotent, and inert once the run has sealed — an interrupt racing the final
   * request cannot produce a second terminal state.
   */
  interrupt(): void {
    if (this.finished) return
    this.interrupted = true
    this.inFlight?.abort()
  }

  /**
   * Issue the plan. Resolves with the run's terminal outcome once every request has
   * either completed or been cancelled.
   *
   * `interrupted` wins whenever the operator stopped it before the plan was
   * exhausted — including before the first request finished, which still seals a
   * head record so the attempt is not invisible.
   */
  async run(): Promise<SpeedTestOutcome> {
    for (let sequence = 1; sequence <= this.plan.plannedCount; sequence++) {
      if (this.interrupted) break
      const startedAt = this.deps.wallClock()
      const sample = await this.issue()
      this.records.push(this.toRecord(sequence, startedAt, sample))
      if (sample.outcome !== 'cancelled') {
        this.onProgress({
          completedCount: this.completedCount,
          successCount: this.successCount,
          failureCount: this.failureCount,
        })
      }
    }
    this.finished = true
    if (this.completedCount < this.plan.plannedCount) return 'interrupted'
    return this.successCount > 0 ? 'completed' : 'failed'
  }

  private toRecord(sequence: number, startedAt: number, s: Sample): SpeedTestRequestRecord {
    return {
      sequence,
      startedAt,
      outcome: s.outcome,
      failureCategory: s.failureCategory,
      httpStatus: s.httpStatus,
      observedModel: s.observedModel,
      ttftMs: s.ttftMs,
      endToEndMs: s.endToEndMs,
      outputTokens: s.outputTokens,
      tokenCountSource: s.tokenCountSource,
      tpotMs: computeTpotMs(s.outcome, s.ttftMs, s.endToEndMs, s.outputTokens),
    }
  }

  /** Dial once and measure. Never throws: every failure becomes a classified sample. */
  private async issue(): Promise<Sample> {
    const { fetch: doFetch, now } = this.deps
    const budget = this.deps.timeoutMs ?? SPEED_TEST_REQUEST_TIMEOUT_MS
    const request = buildRequest(
      this.plan.apiDialect,
      this.plan.baseUrl,
      this.plan.apiKey,
      this.plan.model,
    )
    const reader = createStreamReader(this.plan.apiDialect)
    const sse = new SseDataReader()

    const controller = new AbortController()
    this.inFlight = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, budget)

    const t0 = now()
    let ttftMs: number | null = null
    let usageTokens: number | null = null
    let ended = false
    let inBandError = false

    const elapsed = (): number => now() - t0
    const tokens = (): { outputTokens: number | null; source: Sample['tokenCountSource'] } =>
      usageTokens !== null
        ? { outputTokens: usageTokens, source: 'usage' }
        : { outputTokens: reader.deltaCount, source: 'delta_estimate' }
    const fail = (category: SpeedTestFailureCategory, httpStatus: number | null = null): Sample => {
      const t = tokens()
      return {
        outcome: 'failure',
        failureCategory: category,
        httpStatus,
        observedModel: reader.observedModel,
        ttftMs,
        endToEndMs: elapsed(),
        outputTokens: t.outputTokens,
        tokenCountSource: t.source,
      }
    }
    const cancelled = (): Sample => ({
      outcome: 'cancelled',
      failureCategory: null,
      httpStatus: null,
      observedModel: reader.observedModel,
      ttftMs,
      // A cancelled request has no end to measure to; reporting the abort instant
      // as a duration would put an artificially short sample in the detail table.
      endToEndMs: null,
      outputTokens: null,
      tokenCountSource: null,
    })

    try {
      let response: Response
      try {
        response = await doFetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
          // A 3xx must not carry the account key to a host the operator never
          // configured. The redirect's own status is the honest measurement.
          redirect: 'manual',
        })
      } catch (err) {
        if (this.interrupted) return cancelled()
        if (timedOut) return fail('timeout')
        void err
        return fail('network')
      }

      if (!response.ok) return fail('http', response.status)
      if (!response.body) return fail('stream', response.status)

      const decoder = new TextDecoder()
      const body = response.body.getReader()
      try {
        while (!ended && !inBandError) {
          const chunk = await body.read()
          if (chunk.done) break
          const text = decoder.decode(chunk.value, { stream: true })
          for (const data of sse.push(text)) {
            const signal = reader.push(data)
            if (signal.kind === 'text') {
              if (ttftMs === null) ttftMs = elapsed()
            } else if (signal.kind === 'end') {
              usageTokens = signal.usageTokens
              ended = true
              break
            } else if (signal.kind === 'error') {
              inBandError = true
              break
            }
          }
        }
      } catch (err) {
        if (this.interrupted) return cancelled()
        if (timedOut) return fail('timeout')
        void err
        return fail('network')
      } finally {
        await body.cancel().catch(() => {})
      }

      if (this.interrupted && !ended) return cancelled()
      if (timedOut) return fail('timeout')
      // In-band error, a stream that merely stopped, or one that produced no
      // visible text at all: partial output is not a success sample.
      if (inBandError || !ended || ttftMs === null) return fail('stream', response.status)

      const t = tokens()
      return {
        outcome: 'success',
        failureCategory: null,
        httpStatus: response.status,
        observedModel: reader.observedModel,
        ttftMs,
        endToEndMs: elapsed(),
        outputTokens: t.outputTokens,
        tokenCountSource: t.source,
      }
    } finally {
      clearTimeout(timer)
      this.inFlight = null
    }
  }
}
