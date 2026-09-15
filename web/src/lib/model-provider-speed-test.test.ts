/**
 * 横向对比的选取与排序。
 *
 * 这两条规则合起来回答「这一行拿哪一条数来比」和「谁排前面」——对比视图的全部判断都
 * 落在这两处,所以它们在这里被单独钉住:选错一条记录,读者看到的是另一批数字;排错一次,
 * 读者得到的是另一个结论。
 */
import { describe, expect, it } from 'vitest'
import type { SpeedTestComparisonEntry, SpeedTestRun } from '@ccc/shared/protocol'
import { buildComparisonRows } from './model-provider-speed-test'

/** 一轮只关心 TTFT P50 的测速记录。 */
function run(runId: string, ttftP50Ms: number | null, startedAt = 1_000): SpeedTestRun {
  return {
    runId,
    providerId: 'p',
    providerDisplayName: 'P',
    startedAt,
    finishedAt: startedAt + 1_000,
    plannedCount: 2,
    protocolType: 'openai',
    apiDialect: 'chat',
    model: 'gpt-x',
    calibrationVersion: 'chat-short-v1',
    maxOutputTokens: 128,
    temperature: 0,
    outcome: ttftP50Ms === null ? 'failed' : 'completed',
    summary: {
      completedCount: 2,
      successCount: ttftP50Ms === null ? 0 : 2,
      failureCount: ttftP50Ms === null ? 2 : 0,
      cancelledCount: 0,
      successRate: ttftP50Ms === null ? 0 : 1,
      ttft: {
        sampleCount: ttftP50Ms === null ? 0 : 2,
        avgMs: ttftP50Ms,
        p50Ms: ttftP50Ms,
        p95Ms: ttftP50Ms,
        p99Ms: ttftP50Ms,
      },
      tpot: { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
      endToEnd: { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
      successfulWallTimeMs: 0,
      outputTokensTotal: 0,
      tokensPerSecond: null,
      requestsPerSecond: null,
      estimatedSampleCount: 0,
    },
  }
}

/** 一个 provider 这一列:名字取自 id,记录按传入顺序(调用方约定为最近在前)。 */
function entry(
  providerId: string,
  runs: SpeedTestRun[],
  name = providerId,
): SpeedTestComparisonEntry {
  return { providerId, displayName: name, present: true, runCount: runs.length, runs }
}

const two = entry('a', [run('a-new', 300, 5_000), run('a-old', 100, 1_000)])

describe('buildComparisonRows 的选取', () => {
  it('默认取最近一次,即服务端排在最前的那一条', () => {
    const rows = buildComparisonRows([two])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.run.runId).toBe('a-new')
    expect(rows[0]!.choices.map((r) => r.runId)).toEqual(['a-new', 'a-old'])
  })

  it('尊重用户选中的那一条,并把它带进排序', () => {
    const rows = buildComparisonRows([two], { a: 'a-old' })
    expect(rows[0]!.run.runId).toBe('a-old')
  })

  it('选中的 id 不在备选里时回落到最近一次,而不是让这一行消失', () => {
    // 面板重开、换了浏览器、或那条记录已被清掉之后,记着的 id 都可能失效。
    expect(buildComparisonRows([two], { a: 'deleted-run' })[0]!.run.runId).toBe('a-new')
    expect(buildComparisonRows([two], { unknown: 'a-old' })[0]!.run.runId).toBe('a-new')
  })

  it('跳过没有任何记录的条目,不让一行空数据把整张表带崩', () => {
    expect(buildComparisonRows([entry('empty', []), two]).map((r) => r.providerId)).toEqual(['a'])
  })
})

describe('buildComparisonRows 的排序', () => {
  const fast = entry('fast', [run('f', 100)])
  const slow = entry('slow', [run('s', 900)])
  const broken = entry('broken', [run('b', null)])

  it('升序把 TTFT P50 小的排前面', () => {
    expect(buildComparisonRows([slow, fast], {}, 'asc').map((r) => r.providerId)).toEqual([
      'fast',
      'slow',
    ])
  })

  it('降序把大的排前面', () => {
    expect(buildComparisonRows([fast, slow], {}, 'desc').map((r) => r.providerId)).toEqual([
      'slow',
      'fast',
    ])
  })

  it('P50 不可用的行恒排在最后,升序降序都一样', () => {
    // 方向反转的是「谁更快」,不是「谁没测到」——把不可用行跟着翻到最前,
    // 读起来就成了「它最慢」或「它最快」,两个都不是事实。
    for (const direction of ['asc', 'desc'] as const) {
      // 只有「谁更快」随方向翻转,不可用那一行始终垫底。
      const ordered = direction === 'asc' ? ['fast', 'slow', 'broken'] : ['slow', 'fast', 'broken']
      expect(
        buildComparisonRows([broken, slow, fast], {}, direction).map((r) => r.providerId),
      ).toEqual(ordered)
      expect(
        buildComparisonRows([broken, fast, slow], {}, direction).map((r) => r.providerId),
      ).toEqual(ordered)
    }
  })

  it('读不出来的 P50 按不可用处理,绝不当成 0 排到最快那端', () => {
    const malformed = entry('malformed', [
      {
        ...run('m', 500),
        summary: {
          ...run('m', 500).summary,
          ttft: { sampleCount: 1, avgMs: NaN, p50Ms: NaN, p95Ms: NaN, p99Ms: NaN },
        },
      },
    ])
    expect(buildComparisonRows([malformed, fast], {}, 'asc').map((r) => r.providerId)).toEqual([
      'fast',
      'malformed',
    ])
  })

  it('同值时按展示名、再按 providerId 定序,与输入顺序无关', () => {
    const b = entry('b', [run('b1', 100)], 'Beta')
    const a = entry('a', [run('a1', 100)], 'Alpha')
    const sameName = entry('c', [run('c1', 100)], 'Alpha')
    const expected = ['a', 'c', 'b']
    expect(buildComparisonRows([b, a, sameName]).map((r) => r.providerId)).toEqual(expected)
    expect(buildComparisonRows([sameName, b, a]).map((r) => r.providerId)).toEqual(expected)
  })

  it('排序看的是选中的那一轮,换了记录就换了名次', () => {
    expect(buildComparisonRows([two, fast]).map((r) => r.providerId)).toEqual(['fast', 'a'])
    // a 换到 100ms 那一轮之后与 fast 同值,再按名字定序。
    expect(buildComparisonRows([two, fast], { a: 'a-old' }).map((r) => r.providerId)).toEqual([
      'a',
      'fast',
    ])
  })
})
