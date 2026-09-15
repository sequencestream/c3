/**
 * The append-only speed-test history.
 *
 * The properties under test are the ones that make a record worth keeping: a run
 * is written once and a repeat seal cannot fork it into two histories; a run whose
 * provider has since been deleted is still fully readable, under the name it had;
 * and paging is stable even when two runs share a millisecond.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpeedTestRunDetail } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../../kernel/infra/db.js'
import { summarize } from './stats.js'
import {
  ensureSpeedTestSchema,
  getSpeedTestRunDetail,
  listSpeedTestHistoryProviders,
  listSpeedTestRuns,
  resetSpeedTestStoreForTests,
  saveSpeedTestRun,
} from './store.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-speed-test-store-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetSpeedTestStoreForTests()
  expect(ensureSpeedTestSchema()).toBe(true)
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetSpeedTestStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

/** A two-request run: one success, one 429, ready to seal. */
function detail(over: {
  runId: string
  providerId?: string
  displayName?: string
  startedAt?: number
}): SpeedTestRunDetail {
  const requests: SpeedTestRunDetail['requests'] = [
    {
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
    },
    {
      sequence: 2,
      startedAt: 2_000,
      outcome: 'failure',
      failureCategory: 'http',
      httpStatus: 429,
      ttftMs: null,
      endToEndMs: 200,
      outputTokens: 0,
      tokenCountSource: 'delta_estimate',
      tpotMs: null,
    },
  ]
  return {
    run: {
      runId: over.runId,
      providerId: over.providerId ?? 'p1',
      providerDisplayName: over.displayName ?? 'Example Provider',
      startedAt: over.startedAt ?? 1_000,
      finishedAt: (over.startedAt ?? 1_000) + 5_000,
      plannedCount: 2,
      protocolType: 'openai',
      apiDialect: 'chat',
      model: 'gpt-x',
      calibrationVersion: 'chat-short-v1',
      maxOutputTokens: 128,
      temperature: 0,
      outcome: 'completed',
      summary: summarize(requests),
    },
    requests,
  }
}

describe('speed-test history store', () => {
  it('round-trips a run and every request detail', () => {
    const d = detail({ runId: 'r1' })
    expect(saveSpeedTestRun(d)).toBe(true)

    const read = getSpeedTestRunDetail('r1')
    expect(read).not.toBeNull()
    expect(read!.run).toEqual(d.run)
    expect(read!.requests).toEqual(d.requests)
  })

  it('refuses to insert the same run twice, so a retried save cannot fork history', () => {
    const d = detail({ runId: 'r1' })
    expect(saveSpeedTestRun(d)).toBe(true)
    expect(saveSpeedTestRun(d)).toBe(false)
    expect(listSpeedTestRuns('p1').runs).toHaveLength(1)
    expect(getSpeedTestRunDetail('r1')!.requests).toHaveLength(2)
  })

  it('preserves the unavailable aggregates of an all-failed run', () => {
    const requests: SpeedTestRunDetail['requests'] = [
      {
        sequence: 1,
        startedAt: 1,
        outcome: 'failure',
        failureCategory: 'timeout',
        httpStatus: null,
        ttftMs: null,
        endToEndMs: 60_000,
        outputTokens: 0,
        tokenCountSource: 'delta_estimate',
        tpotMs: null,
      },
    ]
    const d = detail({ runId: 'r-fail' })
    const failed: SpeedTestRunDetail = {
      run: { ...d.run, runId: 'r-fail', outcome: 'failed', summary: summarize(requests) },
      requests,
    }
    saveSpeedTestRun(failed)

    const read = getSpeedTestRunDetail('r-fail')!
    expect(read.run.outcome).toBe('failed')
    expect(read.run.summary.successRate).toBe(0)
    expect(read.run.summary.ttft.p95Ms).toBeNull()
    expect(read.run.summary.tokensPerSecond).toBeNull()
  })

  it('pages newest first and reports whether more remain', () => {
    for (let i = 1; i <= 25; i++) {
      saveSpeedTestRun(detail({ runId: `r${String(i).padStart(2, '0')}`, startedAt: 1_000 + i }))
    }
    const first = listSpeedTestRuns('p1')
    expect(first.runs).toHaveLength(20)
    expect(first.hasMore).toBe(true)
    expect(first.runs[0].runId).toBe('r25')

    const second = listSpeedTestRuns('p1', 20)
    expect(second.runs).toHaveLength(5)
    expect(second.hasMore).toBe(false)
    // No row appears on both pages.
    const ids = new Set([...first.runs, ...second.runs].map((r) => r.runId))
    expect(ids.size).toBe(25)
  })

  it('breaks a same-millisecond tie by run id, so paging cannot duplicate a row', () => {
    saveSpeedTestRun(detail({ runId: 'a', startedAt: 5_000 }))
    saveSpeedTestRun(detail({ runId: 'b', startedAt: 5_000 }))
    expect(listSpeedTestRuns('p1').runs.map((r) => r.runId)).toEqual(['b', 'a'])
  })

  it('keeps a deleted provider’s history readable under its snapshotted name', () => {
    saveSpeedTestRun(detail({ runId: 'r1', providerId: 'gone', displayName: 'Retired Gateway' }))

    // The live configuration no longer contains that provider.
    const providers = listSpeedTestHistoryProviders(new Map())
    expect(providers).toEqual([
      {
        providerId: 'gone',
        displayName: 'Retired Gateway',
        runCount: 1,
        lastStartedAt: 1_000,
        present: false,
      },
    ])
    // And the record itself opens, with no inner join filtering it away.
    expect(getSpeedTestRunDetail('r1')!.run.providerDisplayName).toBe('Retired Gateway')
    expect(listSpeedTestRuns('gone').runs).toHaveLength(1)
  })

  it('shows a surviving provider’s CURRENT name without rewriting the record', () => {
    saveSpeedTestRun(detail({ runId: 'r1', providerId: 'p1', displayName: 'Old Name' }))
    const providers = listSpeedTestHistoryProviders(new Map([['p1', 'New Name']]))
    expect(providers[0]).toMatchObject({ displayName: 'New Name', present: true })
    // History is append-only: the stored snapshot is untouched.
    expect(getSpeedTestRunDetail('r1')!.run.providerDisplayName).toBe('Old Name')
  })

  it('does not let a new provider with the same name inherit another id’s history', () => {
    saveSpeedTestRun(detail({ runId: 'r1', providerId: 'old', displayName: 'Shared Name' }))
    expect(listSpeedTestRuns('new').runs).toEqual([])
  })

  it('groups history providers by id, newest activity first', () => {
    saveSpeedTestRun(detail({ runId: 'a1', providerId: 'a', startedAt: 1_000 }))
    saveSpeedTestRun(detail({ runId: 'b1', providerId: 'b', startedAt: 9_000 }))
    saveSpeedTestRun(detail({ runId: 'a2', providerId: 'a', startedAt: 2_000 }))

    const providers = listSpeedTestHistoryProviders(new Map())
    expect(providers.map((p) => p.providerId)).toEqual(['b', 'a'])
    expect(providers.find((p) => p.providerId === 'a')!.runCount).toBe(2)
  })
})
