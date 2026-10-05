/**
 * The metrics table is a SIDECHANNEL. Its whole contract is "record what the
 * analyzer found, and never be the reason anything fails" — so these tests
 * assert both the rows that land and the rows that do not stop a caller.
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeSpec, type SpecWarning } from './spec-analyzer.js'
import {
  listSpecBaselines,
  listSpecWarningRates,
  listSpecWarnings,
  recordSpecBaselines,
  recordSpecWarnings,
} from './spec-metrics-store.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetStoreForTests } from './store.js'

function warning(
  ruleId = 'no-duplicate-fact',
  detection: SpecWarning['detection'] = 'duplicate_normative_fact',
): SpecWarning {
  return {
    ruleId,
    detection,
    severity: 'warn',
    location: { section: '边界', line: 12 },
    message: 'state it once',
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-metrics-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('recordSpecWarnings', () => {
  it('lands one row per warning, readable back per intent', () => {
    expect(recordSpecWarnings([{ intentId: 'i1', fingerprint: 'fp1', warning: warning() }])).toBe(1)
    const rows = listSpecWarnings('i1')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ruleId).toBe('no-duplicate-fact')
    expect(rows[0]!.severity).toBe('warn')
    expect(rows[0]!.location).toEqual({ section: '边界', line: 12 })
  })

  it('writes nothing, and does not throw, for an empty scan', () => {
    expect(recordSpecWarnings([])).toBe(0)
    expect(listSpecWarnings('nobody')).toEqual([])
  })

  it('never throws when the table is unusable — a broken write must not propagate', () => {
    const rows = Array.from({ length: 50 }, () => ({
      intentId: 'i2',
      fingerprint: 'fp',
      warning: warning(),
    }))
    // A value SQLite cannot store forces the insert to fail mid-batch.
    const poisoned = [
      ...rows,
      { intentId: 'i2', fingerprint: 'fp', warning: { ...warning(), ruleId: undefined as never } },
    ]
    expect(() => recordSpecWarnings(poisoned)).not.toThrow()
    expect(recordSpecWarnings(poisoned)).toBe(0)
  })
})

describe('recordSpecBaselines', () => {
  it('stores a metric with its sample size and measurement definition', () => {
    expect(
      recordSpecBaselines([
        { metric: 'median_review_minutes', value: 12.5, sampleSize: 20, note: '按审核结论时间差' },
      ]),
    ).toBe(1)
    const rows = listSpecBaselines()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ metric: 'median_review_minutes', value: 12.5, sampleSize: 20 })
    expect(rows[0]!.note).toContain('按审核结论时间差')
  })
})

describe('listSpecWarningRates aggregates per rule', () => {
  it('counts hits and distinct specs scanned per rule', () => {
    recordSpecWarnings([
      { intentId: 'i1', fingerprint: 'a', warning: warning() },
      { intentId: 'i1', fingerprint: 'a', warning: warning('empty-heading-rule', 'empty_heading') },
      { intentId: 'i2', fingerprint: 'b', warning: warning() },
    ])
    const rates = listSpecWarningRates()
    const dup = rates.find((r) => r.ruleId === 'no-duplicate-fact')!
    expect(dup.detections).toBe(2)
    expect(dup.specsScanned).toBe(2)
  })

  it('does not mix baseline rows into the warning aggregate', () => {
    recordSpecBaselines([{ metric: 'median_review_minutes', value: 1, sampleSize: 1, note: 'n' }])
    recordSpecWarnings([{ intentId: 'i1', fingerprint: 'a', warning: warning() }])
    expect(listSpecWarningRates().map((r) => r.ruleId)).toEqual(['no-duplicate-fact'])
  })
})

describe('a real analyzer run round-trips through the table', () => {
  it('stores what the analyzer actually found', () => {
    const doc =
      '# 规格\n\n## 方案\n\n返工轮次达到上限后队列必须停止重启作者会话并转人工处理。\n\n## 边界\n\n返工轮次达到上限后队列必须停止重启作者会话并转人工处理。\n'
    const found = analyzeSpec(doc)
    expect(found.length).toBeGreaterThan(0)
    recordSpecWarnings(found.map((w) => ({ intentId: 'i9', fingerprint: 'fp9', warning: w })))
    expect(listSpecWarnings('i9')).toHaveLength(found.length)
  })
})
