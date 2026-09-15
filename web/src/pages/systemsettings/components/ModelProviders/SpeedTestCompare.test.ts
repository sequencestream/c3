/**
 * 跨提供方对比视图。
 *
 * 这里守的是这个视图存在的理由:多条提供方的汇总指标并排、口径提示固定在页面上、
 * 每一行默认取最近一次且能切到别的记录、排序按 TTFT P50 且不可用的行不参与「谁更快」。
 * 断言一律打在 testid、结构与夹具数据上,不比对译文。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { SpeedTestComparisonEntry, SpeedTestRun } from '@ccc/shared/protocol'
import { emptySpeedTestState, type SpeedTestUiState } from '@/lib/model-provider-speed-test'
import SpeedTestCompare from './SpeedTestCompare.vue'

/** 一轮带全套汇总指标的测速记录;传 `failed` 造一个整体失败的轮次。 */
function run(
  runId: string,
  over: Partial<SpeedTestRun> = {},
  ttftP50: number | null = 100,
): SpeedTestRun {
  const failed = ttftP50 === null
  return {
    runId,
    providerId: 'p',
    providerDisplayName: 'P',
    startedAt: 1_000,
    finishedAt: 2_000,
    plannedCount: 2,
    protocolType: 'openai',
    apiDialect: 'chat',
    model: 'gpt-x',
    calibrationVersion: 'chat-short-v1',
    maxOutputTokens: 128,
    temperature: 0,
    outcome: failed ? 'failed' : 'completed',
    summary: {
      completedCount: 2,
      successCount: failed ? 0 : 2,
      failureCount: failed ? 2 : 0,
      cancelledCount: 0,
      successRate: failed ? 0 : 1,
      ttft: {
        sampleCount: failed ? 0 : 2,
        avgMs: ttftP50,
        p50Ms: ttftP50,
        p95Ms: ttftP50,
        p99Ms: ttftP50,
      },
      tpot: { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
      endToEnd: { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
      successfulWallTimeMs: 1_000,
      outputTokensTotal: 20,
      tokensPerSecond: 20,
      requestsPerSecond: 2,
      estimatedSampleCount: 0,
    },
    ...over,
  }
}

function entry(
  providerId: string,
  runs: SpeedTestRun[],
  over: Partial<SpeedTestComparisonEntry> = {},
): SpeedTestComparisonEntry {
  return {
    providerId,
    displayName: providerId,
    present: true,
    runCount: runs.length,
    runs,
    ...over,
  }
}

/** 三种形态:正常一条、有多次记录的一条、整体失败的一条。 */
const fast = entry('fast', [run('f-new', {}, 100), run('f-old', {}, 800)])
const slow = entry('slow', [run('s-new', {}, 900)])
const broken = entry('broken', [run('b-new', {}, null)])

function render(compare: SpeedTestComparisonEntry[] | null, over: Partial<SpeedTestUiState> = {}) {
  const state: SpeedTestUiState = { ...emptySpeedTestState(), compareOpen: true, compare, ...over }
  return mount(SpeedTestCompare, { props: { state } })
}

const providerNames = (w: ReturnType<typeof render>) =>
  w.findAll('[data-testid="speed-test-compare-provider"]').map((n) => n.text())

const cellTexts = (w: ReturnType<typeof render>, testid: string) =>
  w.findAll(`[data-testid="${testid}"]`).map((n) => n.text())

describe('对比视图的取数与空态', () => {
  it('还没取回数据时显示加载态,不显示空态', () => {
    const w = render(null)
    expect(w.find('[data-testid="speed-test-compare-loading"]').exists()).toBe(true)
    expect(w.find('[data-testid="speed-test-compare-empty"]').exists()).toBe(false)
  })

  it('一条记录都没有时显示空态,而不是报错', () => {
    const w = render([])
    expect(w.find('[data-testid="speed-test-compare-empty"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="speed-test-compare-row"]')).toHaveLength(0)
    expect(w.find('[data-testid="speed-test-compare-failed"]').exists()).toBe(false)
  })

  it('取数被拒时说清原因并给一次重试,不停在「加载中」', async () => {
    const w = render(null, { error: 'db_unavailable' })
    expect(w.find('[data-testid="speed-test-compare-loading"]').exists()).toBe(false)
    expect(w.find('[data-testid="speed-test-compare-failed"]').text()).not.toBe('')
    await w.find('[data-testid="speed-test-compare-retry"]').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })
})

describe('对比表的排布', () => {
  it('每个有记录的提供方一行,默认按 TTFT P50 升序、不可用的那行垫底', () => {
    const w = render([slow, broken, fast])
    // 输入顺序被打乱也照排:升序 100 < 900,整体失败的 broken 恒排最后。
    expect(providerNames(w)).toEqual(['fast', 'slow', 'broken'])
  })

  it('口径提示固定在页面上', () => {
    for (const compare of [null, [], [fast]]) {
      expect(render(compare).find('[data-testid="speed-test-compare-note"]').text()).not.toBe('')
    }
  })

  it('整体失败的一行:成功率为 0,延迟列是不可用而不是 0 或空白', () => {
    const w = render([broken])
    expect(cellTexts(w, 'speed-test-compare-success-rate')).toEqual(['0.0%'])
    // 「没测到」不能画成 0:0 会被读成「这个端点一个 token 都没产出」。
    const ttft = cellTexts(w, 'speed-test-compare-ttft-p50')[0]!
    expect(ttft).not.toBe('0')
    expect(ttft).not.toBe('')
    expect(cellTexts(w, 'speed-test-compare-tps')[0]).not.toBe('0')
  })

  it('每条提供方默认取最近一次,并给出全部备选', () => {
    const w = render([fast])
    const select = w.find('[data-testid="speed-test-compare-run"] select')
    expect((select.element as HTMLSelectElement).value).toBe('f-new')
    expect(select.findAll('option')).toHaveLength(2)
  })

  it('只有一条记录时不摆下拉:一个只能选它自己的控件会让人以为还有别的', () => {
    const w = render([slow])
    expect(w.find('[data-testid="speed-test-compare-run"] select').exists()).toBe(false)
    expect(w.find('[data-testid="speed-test-compare-run"]').text()).not.toBe('')
  })
})

describe('对比表的交互', () => {
  it('把某行切到非最近一次的记录,该行改用那一轮的指标并重新排序', async () => {
    const w = render([fast, slow])
    expect(providerNames(w)).toEqual(['fast', 'slow'])
    expect(cellTexts(w, 'speed-test-compare-ttft-p50')).toEqual(['100.0', '900.0'])

    await w.find('[data-testid="speed-test-compare-run"] select').setValue('f-old')

    // 100 → 800:仍然比 slow 快,但数字换成了被选中的那一轮。
    expect(cellTexts(w, 'speed-test-compare-ttft-p50')).toEqual(['800.0', '900.0'])
    expect(providerNames(w)).toEqual(['fast', 'slow'])
  })

  it('切换记录后若名次应当改变,表格随之重排', async () => {
    // fast 的最近一次最快,但它更早的那一轮比 slow 还慢 —— 换个记录就该换名次。
    const slower = run('f-slower', {}, 1_500)
    const w = render([entry('fast', [run('f-new', {}, 100), slower]), slow])
    expect(providerNames(w)).toEqual(['fast', 'slow'])

    await w.find('[data-testid="speed-test-compare-run"] select').setValue('f-slower')
    expect(providerNames(w)).toEqual(['slow', 'fast'])
  })

  it('点排序表头翻转升降序,不可用的行始终垫底', async () => {
    const w = render([fast, slow, broken])
    expect(providerNames(w)).toEqual(['fast', 'slow', 'broken'])

    await w.find('[data-testid="speed-test-compare-sort"]').trigger('click')
    expect(providerNames(w)).toEqual(['slow', 'fast', 'broken'])

    await w.find('[data-testid="speed-test-compare-sort"]').trigger('click')
    expect(providerNames(w)).toEqual(['fast', 'slow', 'broken'])
  })

  it('已删除的提供方仍占一行,并在名字上标出来', () => {
    const w = render([
      entry('gone', [run('g', {}, 100)], { present: false, displayName: 'Retired' }),
    ])
    expect(providerNames(w)).toHaveLength(1)
  })
})
