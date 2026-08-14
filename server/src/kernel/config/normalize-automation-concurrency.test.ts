/**
 * Unit tests for the workspace automation-queue concurrent-dev cap normalize rule:
 * - Absent / non-number / non-finite values fall back to the default `2`.
 * - A finite number is floored; values below `1` are clamped up to `1`.
 * - A valid positive integer is preserved as-is, and survives a round-trip.
 *
 * Exercised through the public `normalizeWorkspaceSetting(raw)` and the
 * `getAutomationConcurrency` accessor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSetting } from '@ccc/shared/protocol'
import {
  normalizeWorkspaceSetting,
  getAutomationConcurrency,
  saveWorkspaceSetting,
  loadWorkspaceSetting,
} from './index.js'
import { releaseConfigDb, useConfigDb } from './config-fixture.js'

const TEST_PROJ = '/test/project'

let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'c3-automation-concurrency-'))
  useConfigDb(tmpDir)
})
afterEach(() => {
  releaseConfigDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('automation-concurrency normalize (via normalizeWorkspaceSetting)', () => {
  it('defaults to 2 when the field is absent', () => {
    expect(normalizeWorkspaceSetting({}).automationConcurrency).toBe(2)
  })

  it('defaults to 2 on a null/non-object raw', () => {
    expect(normalizeWorkspaceSetting(null).automationConcurrency).toBe(2)
    expect(normalizeWorkspaceSetting(undefined).automationConcurrency).toBe(2)
  })

  it('keeps a valid positive integer unchanged', () => {
    expect(normalizeWorkspaceSetting({ automationConcurrency: 1 }).automationConcurrency).toBe(1)
    expect(normalizeWorkspaceSetting({ automationConcurrency: 2 }).automationConcurrency).toBe(2)
    expect(normalizeWorkspaceSetting({ automationConcurrency: 5 }).automationConcurrency).toBe(5)
  })

  it('floors fractional values', () => {
    expect(normalizeWorkspaceSetting({ automationConcurrency: 2.9 }).automationConcurrency).toBe(2)
    expect(normalizeWorkspaceSetting({ automationConcurrency: 3.01 }).automationConcurrency).toBe(3)
  })

  it('clamps values below 1 up to 1 (never default)', () => {
    expect(normalizeWorkspaceSetting({ automationConcurrency: 0 }).automationConcurrency).toBe(1)
    expect(normalizeWorkspaceSetting({ automationConcurrency: 0.5 }).automationConcurrency).toBe(1)
    expect(normalizeWorkspaceSetting({ automationConcurrency: -3 }).automationConcurrency).toBe(1)
  })

  it('falls back to 2 for string, boolean and non-finite values', () => {
    expect(normalizeWorkspaceSetting({ automationConcurrency: '4' }).automationConcurrency).toBe(2)
    expect(normalizeWorkspaceSetting({ automationConcurrency: true }).automationConcurrency).toBe(2)
    expect(normalizeWorkspaceSetting({ automationConcurrency: null }).automationConcurrency).toBe(2)
    expect(normalizeWorkspaceSetting({ automationConcurrency: NaN }).automationConcurrency).toBe(2)
    expect(
      normalizeWorkspaceSetting({ automationConcurrency: Infinity }).automationConcurrency,
    ).toBe(2)
    expect(
      normalizeWorkspaceSetting({ automationConcurrency: -Infinity }).automationConcurrency,
    ).toBe(2)
  })

  it('preserves the cap when other fields are saved (round-trip)', () => {
    const first = normalizeWorkspaceSetting({ automationConcurrency: 4, devSkill: '/foo' })
    expect(first.automationConcurrency).toBe(4)
    const roundTripped = normalizeWorkspaceSetting({ ...first, devSkill: '/bar' })
    expect(roundTripped.automationConcurrency).toBe(4)
    expect(roundTripped.devSkill).toBe('/bar')
  })
})

describe('getAutomationConcurrency — accessor', () => {
  it('reads a saved integer as-is and normalizes a fractional value', () => {
    saveWorkspaceSetting(TEST_PROJ, { automationConcurrency: 4 } as WorkspaceSetting)
    expect(getAutomationConcurrency(TEST_PROJ)).toBe(4)
    expect(loadWorkspaceSetting(TEST_PROJ).automationConcurrency).toBe(4)

    saveWorkspaceSetting(TEST_PROJ, { automationConcurrency: 3.7 } as WorkspaceSetting)
    expect(getAutomationConcurrency(TEST_PROJ)).toBe(3)
  })

  it('defaults to 2 when the workspace has no saved value', () => {
    saveWorkspaceSetting(TEST_PROJ, {} as WorkspaceSetting)
    expect(getAutomationConcurrency(TEST_PROJ)).toBe(2)
  })
})
