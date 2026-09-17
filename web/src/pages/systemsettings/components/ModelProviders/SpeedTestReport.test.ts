import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { SpeedTestRun } from '@ccc/shared/protocol'
import { emptySpeedTestState } from '@/lib/model-provider-speed-test'
import SpeedTestReport from './SpeedTestReport.vue'

function run(model: string, observedModels: string[]): SpeedTestRun {
  const emptyLatency = { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null }
  return {
    runId: 'r1',
    providerId: 'p1',
    providerDisplayName: 'Provider',
    startedAt: 1_000,
    finishedAt: 2_000,
    plannedCount: 1,
    protocolType: 'openai',
    apiDialect: 'chat',
    model,
    observedModels,
    calibrationVersion: 'chat-short-v1',
    maxOutputTokens: 128,
    temperature: 0,
    outcome: 'completed',
    summary: {
      completedCount: 1,
      successCount: 1,
      failureCount: 0,
      cancelledCount: 0,
      successRate: 1,
      ttft: emptyLatency,
      tpot: emptyLatency,
      endToEnd: emptyLatency,
      successfulWallTimeMs: 1,
      outputTokensTotal: 1,
      tokensPerSecond: 1,
      requestsPerSecond: 1,
      estimatedSampleCount: 0,
    },
  }
}

describe('SpeedTestReport model evidence', () => {
  it('shows requested to observed and preserves unknown for legacy records', () => {
    const observed = run('', ['actual-model'])
    const legacy = { ...run('requested-model', []), runId: 'r2' }
    const state = {
      ...emptySpeedTestState(),
      reportOpen: true,
      reportProviderId: 'p1',
      history: { providerId: 'p1', runs: [observed, legacy], hasMore: false },
      detail: {
        run: legacy,
        requests: [
          {
            sequence: 1,
            startedAt: 1_000,
            outcome: 'success' as const,
            failureCategory: null,
            httpStatus: 200,
            observedModel: null,
            ttftMs: 1,
            endToEndMs: 1,
            outputTokens: 1,
            tokenCountSource: 'usage' as const,
            tpotMs: null,
          },
        ],
      },
    }
    const wrapper = mount(SpeedTestReport, { props: { state } })
    const rows = wrapper.findAll('[data-testid="speed-test-report-row"]').map((row) => row.text())
    expect(rows[0]).toContain('Default / unspecified → actual-model')
    expect(rows[1]).toContain('requested-model → Unknown')
    expect(wrapper.find('[data-testid="speed-test-target"]').text()).toContain(
      'requested-model → Unknown',
    )
    expect(wrapper.find('[data-testid="speed-test-request-row"]').text()).toContain(
      'requested-model → Unknown',
    )
  })
})
