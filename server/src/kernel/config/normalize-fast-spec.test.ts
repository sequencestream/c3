/**
 * Tests for the fast-spec threshold normalizers. Both bounds are STRICTLY
 * less-than (reaching the configured value is over the threshold) and clamp up
 * to a minimum of 1; any invalid input falls back to the default. Mirror of
 * `normalize-automation-concurrency.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FAST_SPEC_MAX_FILES,
  DEFAULT_FAST_SPEC_MAX_LINES,
  MIN_FAST_SPEC_MAX_FILES,
  MIN_FAST_SPEC_MAX_LINES,
  normalizeFastSpecMaxFiles,
  normalizeFastSpecMaxLines,
} from './index.js'

describe('normalizeFastSpecMaxFiles', () => {
  it('keeps a valid positive integer', () => {
    expect(normalizeFastSpecMaxFiles(3)).toBe(3)
    expect(normalizeFastSpecMaxFiles(1)).toBe(1)
  })

  it('floors fractions and clamps up to the minimum', () => {
    expect(normalizeFastSpecMaxFiles(2.9)).toBe(2)
    expect(normalizeFastSpecMaxFiles(0.5)).toBe(MIN_FAST_SPEC_MAX_FILES)
  })

  it('falls back to the default for absent / non-finite / non-positive input', () => {
    expect(normalizeFastSpecMaxFiles(undefined)).toBe(DEFAULT_FAST_SPEC_MAX_FILES)
    expect(normalizeFastSpecMaxFiles(NaN)).toBe(DEFAULT_FAST_SPEC_MAX_FILES)
    expect(normalizeFastSpecMaxFiles(Infinity)).toBe(DEFAULT_FAST_SPEC_MAX_FILES)
    expect(normalizeFastSpecMaxFiles(0)).toBe(DEFAULT_FAST_SPEC_MAX_FILES)
    expect(normalizeFastSpecMaxFiles(-3)).toBe(DEFAULT_FAST_SPEC_MAX_FILES)
    expect(normalizeFastSpecMaxFiles('3')).toBe(DEFAULT_FAST_SPEC_MAX_FILES)
  })
})

describe('normalizeFastSpecMaxLines', () => {
  it('keeps a valid positive integer', () => {
    expect(normalizeFastSpecMaxLines(50)).toBe(50)
  })

  it('floors fractions and clamps up to the minimum', () => {
    expect(normalizeFastSpecMaxLines(49.9)).toBe(49)
    expect(normalizeFastSpecMaxLines(0.5)).toBe(MIN_FAST_SPEC_MAX_LINES)
  })

  it('falls back to the default for absent / non-finite / non-positive input', () => {
    expect(normalizeFastSpecMaxLines(undefined)).toBe(DEFAULT_FAST_SPEC_MAX_LINES)
    expect(normalizeFastSpecMaxLines(NaN)).toBe(DEFAULT_FAST_SPEC_MAX_LINES)
    expect(normalizeFastSpecMaxLines(Infinity)).toBe(DEFAULT_FAST_SPEC_MAX_LINES)
    expect(normalizeFastSpecMaxLines(0)).toBe(DEFAULT_FAST_SPEC_MAX_LINES)
    expect(normalizeFastSpecMaxLines(-1)).toBe(DEFAULT_FAST_SPEC_MAX_LINES)
    expect(normalizeFastSpecMaxLines('50')).toBe(DEFAULT_FAST_SPEC_MAX_LINES)
  })
})
