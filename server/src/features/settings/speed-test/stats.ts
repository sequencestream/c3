/**
 * Speed-test statistics. Pure: samples in, aggregate out — no clock, no IO, no
 * upstream. Every formula the report shows is defined here once and documented on
 * the wire types in `@ccc/shared/protocol`; nothing downstream recomputes a metric.
 *
 * Three rules do all the work, and each exists to stop a specific lie:
 *
 *  - **Only successes carry latency.** A request that timed out at 60s would
 *    dominate any average it entered, and a request that died after 3 tokens would
 *    flatter TPOT. Failures still count toward the success rate — that is where
 *    they belong — but never toward a duration.
 *  - **Cancelled is not failed.** Aborting an in-flight request is the operator
 *    stopping the measurement, not the provider misbehaving. It scores nothing.
 *  - **Nearest-rank, no interpolation.** Every reported percentile is a value that
 *    was actually observed. With ten samples P95 and P99 are both the maximum;
 *    that is honest, and `sampleCount` travels alongside so nobody reads it as a
 *    tail estimate.
 */
import type {
  SpeedTestLatencyStats,
  SpeedTestRequestRecord,
  SpeedTestSummary,
} from '@ccc/shared/protocol'

/** The empty distribution: no samples, therefore no values — not zeros. */
const EMPTY_STATS: SpeedTestLatencyStats = {
  sampleCount: 0,
  avgMs: null,
  p50Ms: null,
  p95Ms: null,
  p99Ms: null,
}

/**
 * Nearest-rank percentile over an ASCENDING array: `x[ceil(p * m) - 1]`, clamped
 * into range. `p` is a fraction (0.95, not 95). No interpolation, so the result is
 * always a value the run actually observed. `null` for an empty array.
 */
export function nearestRank(sortedAsc: readonly number[], p: number): number | null {
  const m = sortedAsc.length
  if (m === 0) return null
  const rank = Math.ceil(p * m)
  const index = Math.min(Math.max(rank, 1), m) - 1
  return sortedAsc[index]
}

/**
 * The distribution of one metric. `avgMs` is the arithmetic mean; the three
 * percentiles are {@link nearestRank}. A single sample makes all four equal —
 * an honest report of "we measured this once", not a spread.
 */
export function latencyStats(samples: readonly number[]): SpeedTestLatencyStats {
  if (samples.length === 0) return { ...EMPTY_STATS }
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    sampleCount: sorted.length,
    avgMs: sum / sorted.length,
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    p99Ms: nearestRank(sorted, 0.99),
  }
}

/** Collect one non-null numeric field across the given records. */
function samplesOf(
  records: readonly SpeedTestRequestRecord[],
  pick: (r: SpeedTestRequestRecord) => number | null,
): number[] {
  const out: number[] = []
  for (const r of records) {
    const value = pick(r)
    if (value !== null) out.push(value)
  }
  return out
}

/**
 * Time per output token for one successful request:
 * `(endToEndMs - ttftMs) / (outputTokens - 1)`.
 *
 * `null` unless the request succeeded with at least TWO output tokens. The first
 * token's latency is TTFT, so it is excluded from both numerator and denominator;
 * with one token there is no inter-token interval to measure at all, and dividing
 * by `outputTokens` instead would quietly report a number that is neither.
 */
export function computeTpotMs(
  outcome: SpeedTestRequestRecord['outcome'],
  ttftMs: number | null,
  endToEndMs: number | null,
  outputTokens: number | null,
): number | null {
  if (outcome !== 'success') return null
  if (ttftMs === null || endToEndMs === null || outputTokens === null) return null
  if (outputTokens < 2) return null
  return (endToEndMs - ttftMs) / (outputTokens - 1)
}

/**
 * Aggregate one run's recorded requests.
 *
 * Throughput uses `successfulWallTimeMs` — the time successful requests OCCUPIED,
 * summed. Because sampling is serial that is close to, but never the same as, the
 * run's elapsed time: failures, cancellations and the gaps between requests are
 * excluded on purpose, so a run that spent 50s waiting out one timeout does not
 * report a throughput a tenth of the truth. It is not a capacity figure.
 *
 * Both rates are `null` rather than `Infinity`/`NaN` when there is nothing to
 * divide by, and the console renders that as a localized "unavailable" — never 0,
 * which would read as "this endpoint produced no tokens".
 */
export function summarize(records: readonly SpeedTestRequestRecord[]): SpeedTestSummary {
  const successes = records.filter((r) => r.outcome === 'success')
  const successCount = successes.length
  const failureCount = records.filter((r) => r.outcome === 'failure').length
  const cancelledCount = records.filter((r) => r.outcome === 'cancelled').length
  const completedCount = successCount + failureCount

  const successfulWallTimeMs = successes.reduce((acc, r) => acc + (r.endToEndMs ?? 0), 0)
  const outputTokensTotal = successes.reduce((acc, r) => acc + (r.outputTokens ?? 0), 0)
  const seconds = successfulWallTimeMs / 1000
  const rateDivisible = successCount > 0 && successfulWallTimeMs > 0

  return {
    completedCount,
    successCount,
    failureCount,
    cancelledCount,
    successRate: completedCount === 0 ? null : successCount / completedCount,
    ttft: latencyStats(samplesOf(successes, (r) => r.ttftMs)),
    tpot: latencyStats(samplesOf(successes, (r) => r.tpotMs)),
    endToEnd: latencyStats(samplesOf(successes, (r) => r.endToEndMs)),
    successfulWallTimeMs,
    outputTokensTotal,
    tokensPerSecond: rateDivisible ? outputTokensTotal / seconds : null,
    requestsPerSecond: rateDivisible ? successCount / seconds : null,
    estimatedSampleCount: successes.filter((r) => r.tokenCountSource === 'delta_estimate').length,
  }
}
