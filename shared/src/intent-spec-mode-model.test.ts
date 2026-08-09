/**
 * `canEditIntentSpecMode` — the one "may specMode still be changed" criterion.
 * Editable only while spec AND development are both un-started; each lock branch
 * is asserted on its own so a future signal cannot silently widen the gate.
 */
import { describe, expect, it } from 'vitest'
import { canEditIntentSpecMode, type SpecModeEditFacts } from './intent-spec-mode-model.js'

function facts(overrides: Partial<SpecModeEditFacts> = {}): SpecModeEditFacts {
  return {
    specPath: null,
    specStatus: 'raw',
    specSessionId: null,
    specReviewSessionId: null,
    lastWorkSessionId: null,
    ...overrides,
  }
}

describe('canEditIntentSpecMode', () => {
  it('allows editing while nothing has started', () => {
    expect(canEditIntentSpecMode(facts())).toBe(true)
  })

  it('locks once a spec document exists (specPath set)', () => {
    expect(canEditIntentSpecMode(facts({ specPath: 'doc/spec.md' }))).toBe(false)
  })

  it('locks on any spec status past raw', () => {
    for (const specStatus of ['pending', 'approved'] as const) {
      expect(canEditIntentSpecMode(facts({ specStatus })), specStatus).toBe(false)
    }
  })

  it('locks once a spec-authoring session was started', () => {
    expect(canEditIntentSpecMode(facts({ specSessionId: 's1' }))).toBe(false)
  })

  it('locks once a spec-review session was started', () => {
    expect(canEditIntentSpecMode(facts({ specReviewSessionId: 's2' }))).toBe(false)
  })

  it('locks once development ran (lastWorkSessionId set) — this is what covers merged intents', () => {
    expect(canEditIntentSpecMode(facts({ lastWorkSessionId: 'w1' }))).toBe(false)
  })

  it('treats blank / whitespace-only strings as absent, so legacy empty rows stay editable', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(
        canEditIntentSpecMode(
          facts({
            specPath: blank,
            specSessionId: blank,
            specReviewSessionId: blank,
            lastWorkSessionId: blank,
          }),
        ),
        JSON.stringify(blank),
      ).toBe(true)
    }
  })

  it('treats undefined the same as null for every optional field', () => {
    expect(
      canEditIntentSpecMode({
        specPath: undefined,
        specStatus: 'raw',
        specSessionId: undefined,
        specReviewSessionId: undefined,
        lastWorkSessionId: undefined,
      }),
    ).toBe(true)
  })

  it('stays locked when several signals combine, and needs ALL five clear to unlock', () => {
    const all = facts({
      specPath: 'doc/spec.md',
      specStatus: 'approved',
      specSessionId: 's1',
      specReviewSessionId: 's2',
      lastWorkSessionId: 'w1',
    })
    expect(canEditIntentSpecMode(all)).toBe(false)
    // Clearing any four of the five still leaves the fifth holding the lock.
    const keys = [
      'specPath',
      'specStatus',
      'specSessionId',
      'specReviewSessionId',
      'lastWorkSessionId',
    ] as const
    for (const keep of keys) {
      const only = facts({ [keep]: all[keep] } as Partial<SpecModeEditFacts>)
      expect(canEditIntentSpecMode(only), keep).toBe(false)
    }
  })
})
