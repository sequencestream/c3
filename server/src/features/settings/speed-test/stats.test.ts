/**
 * The metric contract, pinned to exact numbers.
 *
 * These are the assertions the whole capability rests on: a percentile is a value
 * that was actually observed, a failure moves the success rate but never a latency,
 * a cancellation moves nothing at all, and an undefined quotient is `null` rather
 * than `0`, `NaN` or `Infinity`. Everything downstream — the report, the eventual
 * cross-provider comparison — reads these numbers without recomputing them, so a
 * silent change here would be invisible until someone made a procurement decision
 * on it.
 */
import { describe, expect, it } from 'vitest'
import type { SpeedTestRequestRecord } from '@ccc/shared/protocol'
import { computeTpotMs, latencyStats, nearestRank, summarize } from './stats.js'

/** A successful sample; every field the aggregates read is explicit. */
function success(over: Partial<SpeedTestRequestRecord> = {}): SpeedTestRequestRecord {
  const base: SpeedTestRequestRecord = {
    sequence: 1,
    startedAt: 1_000,
    outcome: 'success',
    failureCategory: null,
    httpStatus: 200,
    ttftMs: 100,
    endToEndMs: 1_000,
    outputTokens: 10,
    tokenCountSource: 'usage',
    tpotMs: 100,
  }
  return { ...base, ...over }
}

function failure(over: Partial<SpeedTestRequestRecord> = {}): SpeedTestRequestRecord {
  return {
    sequence: 2,
    startedAt: 2_000,
    outcome: 'failure',
    failureCategory: 'http',
    httpStatus: 429,
    ttftMs: null,
    endToEndMs: 250,
    outputTokens: 0,
    tokenCountSource: 'delta_estimate',
    tpotMs: null,
    ...over,
  }
}

function cancelled(over: Partial<SpeedTestRequestRecord> = {}): SpeedTestRequestRecord {
  return {
    sequence: 3,
    startedAt: 3_000,
    outcome: 'cancelled',
    failureCategory: null,
    httpStatus: null,
    ttftMs: 90,
    endToEndMs: null,
    outputTokens: null,
    tokenCountSource: null,
    tpotMs: null,
    ...over,
  }
}

describe('nearestRank', () => {
  const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

  it('picks x[ceil(p*m)-1] with no interpolation', () => {
    expect(nearestRank(ten, 0.5)).toBe(50)
    expect(nearestRank(ten, 0.95)).toBe(100)
    expect(nearestRank(ten, 0.99)).toBe(100)
  })

  it('returns null for an empty sample set rather than 0', () => {
    expect(nearestRank([], 0.5)).toBeNull()
  })

  it('clamps into range at both ends', () => {
    expect(nearestRank(ten, 0)).toBe(10)
    expect(nearestRank(ten, 1)).toBe(100)
  })
})

describe('latencyStats', () => {
  it('reports avg 55 / P50 50 / P95 100 / P99 100 for the canonical ten samples', () => {
    expect(latencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({
      sampleCount: 10,
      avgMs: 55,
      p50Ms: 50,
      p95Ms: 100,
      p99Ms: 100,
    })
  })

  it('sorts before ranking, so arrival order cannot change a percentile', () => {
    const shuffled = [70, 10, 100, 40, 30, 90, 20, 60, 50, 80]
    expect(latencyStats(shuffled)).toEqual(latencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]))
  })

  it('makes all four values equal for a single sample', () => {
    expect(latencyStats([42])).toEqual({
      sampleCount: 1,
      avgMs: 42,
      p50Ms: 42,
      p95Ms: 42,
      p99Ms: 42,
    })
  })

  it('reports null — not zero — for every value of an empty set', () => {
    expect(latencyStats([])).toEqual({
      sampleCount: 0,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    })
  })
})

describe('computeTpotMs', () => {
  it('excludes the first token from both numerator and denominator', () => {
    // TTFT 100, end-to-end 1000, 10 tokens ⇒ 900ms spread over 9 intervals.
    expect(computeTpotMs('success', 100, 1_000, 10)).toBe(100)
  })

  it('is null for a single output token — there is no inter-token interval', () => {
    expect(computeTpotMs('success', 100, 1_000, 1)).toBeNull()
  })

  it('is null for anything that did not succeed', () => {
    expect(computeTpotMs('failure', 100, 1_000, 10)).toBeNull()
    expect(computeTpotMs('cancelled', 100, 1_000, 10)).toBeNull()
  })

  it('is null when a required observation is missing', () => {
    expect(computeTpotMs('success', null, 1_000, 10)).toBeNull()
    expect(computeTpotMs('success', 100, null, 10)).toBeNull()
    expect(computeTpotMs('success', 100, 1_000, null)).toBeNull()
  })
})

describe('summarize', () => {
  it('derives the documented throughput from one canonical successful sample', () => {
    const s = summarize([success()])
    expect(s.successRate).toBe(1)
    expect(s.tpot.avgMs).toBe(100)
    expect(s.tokensPerSecond).toBe(10)
    expect(s.requestsPerSecond).toBe(1)
  })

  it('lets a failure move the success rate without touching any latency statistic', () => {
    const only = summarize([success()])
    const withFailure = summarize([success(), failure()])

    expect(withFailure.completedCount).toBe(2)
    expect(withFailure.successRate).toBe(0.5)
    // The failed request observed 250ms end-to-end; it must not appear anywhere.
    expect(withFailure.ttft).toEqual(only.ttft)
    expect(withFailure.tpot).toEqual(only.tpot)
    expect(withFailure.endToEnd).toEqual(only.endToEnd)
    expect(withFailure.tokensPerSecond).toBe(only.tokensPerSecond)
    expect(withFailure.requestsPerSecond).toBe(only.requestsPerSecond)
  })

  it('scores a cancelled request as neither success nor failure', () => {
    const s = summarize([success(), cancelled()])
    expect(s.completedCount).toBe(1)
    expect(s.cancelledCount).toBe(1)
    expect(s.successRate).toBe(1)
    expect(s.endToEnd.sampleCount).toBe(1)
  })

  it('reports rate 0 and unavailable latencies when every request failed', () => {
    const s = summarize([failure({ sequence: 1 }), failure({ sequence: 2 })])
    expect(s.successRate).toBe(0)
    expect(s.ttft.sampleCount).toBe(0)
    expect(s.ttft.p95Ms).toBeNull()
    expect(s.tokensPerSecond).toBeNull()
    expect(s.requestsPerSecond).toBeNull()
  })

  it('has a null success rate when nothing completed at all', () => {
    expect(summarize([]).successRate).toBeNull()
    expect(summarize([cancelled()]).successRate).toBeNull()
  })

  it('never yields Infinity or NaN when successful wall time is zero', () => {
    const s = summarize([success({ endToEndMs: 0, ttftMs: 0, outputTokens: 5, tpotMs: 0 })])
    expect(s.tokensPerSecond).toBeNull()
    expect(s.requestsPerSecond).toBeNull()
  })

  it('counts how many successful samples estimated their token count', () => {
    const s = summarize([
      success({ sequence: 1 }),
      success({ sequence: 2, tokenCountSource: 'delta_estimate' }),
      failure({ sequence: 3, tokenCountSource: 'delta_estimate' }),
    ])
    // The failed sample estimated too, but it is not part of any aggregate.
    expect(s.estimatedSampleCount).toBe(1)
  })

  it('sums throughput over successes only, excluding failed wall time', () => {
    const s = summarize([
      success({ sequence: 1, endToEndMs: 1_000, outputTokens: 10 }),
      success({ sequence: 2, endToEndMs: 1_000, outputTokens: 30 }),
      failure({ sequence: 3, endToEndMs: 60_000 }),
    ])
    expect(s.successfulWallTimeMs).toBe(2_000)
    expect(s.outputTokensTotal).toBe(40)
    expect(s.tokensPerSecond).toBe(20)
    expect(s.requestsPerSecond).toBe(1)
  })
})
