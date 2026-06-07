/**
 * Per-vendor mode-catalog contract + token ⇄ grid translation tests
 * (ADR-0011, 2026-06-07-012). Two halves:
 *  - The catalog contract every vendor's {@link VendorModeCatalog} must satisfy
 *    (the runtime drift-pin companion to the `Record<VendorId, …>` compile pin).
 *  - The bidirectional translation for each of the three adapters: every declared
 *    token round-trips through the neutral grid, and the lossy reverse picks the
 *    nearest token (never crossing the plan/build action boundary).
 */
import { describe, it, expect } from 'vitest'
import type { ActionMode, ToolGate, VendorModeCatalog } from './types.js'
import { MODE_CATALOGS, tokenToGrid, gridToToken, isKnownToken } from './index.js'
import { claudeModeCatalog } from './claude/modes.js'
import { codexModeCatalog } from './codex/modes.js'
import { opencodeModeCatalog } from './opencode/modes.js'

const ACTION_MODES: ActionMode[] = ['plan', 'build']
const TOOL_GATES: ToolGate[] = ['always-ask', 'on-sensitive', 'trusted-prefix', 'never-ask']

describe('MODE_CATALOGS contract', () => {
  it('registers exactly the three current vendors', () => {
    expect(Object.keys(MODE_CATALOGS).sort()).toEqual(['claude', 'codex', 'opencode'])
  })

  for (const [key, cat] of Object.entries(MODE_CATALOGS)) {
    describe(`${key} catalog`, () => {
      it('declares its own registry key as its vendor', () => {
        expect(cat.vendor).toBe(key)
      })
      it('has at least one mode', () => {
        expect(cat.modes.length).toBeGreaterThan(0)
      })
      it('uses unique tokens', () => {
        const tokens = cat.modes.map((m) => m.token)
        expect(new Set(tokens).size).toBe(tokens.length)
      })
      it('defaultToken is one of its modes', () => {
        expect(cat.modes.some((m) => m.token === cat.defaultToken)).toBe(true)
      })
      it('every mode has a non-empty labelCode and a valid grid cell', () => {
        for (const m of cat.modes) {
          expect(m.labelCode.length).toBeGreaterThan(0)
          expect(ACTION_MODES).toContain(m.actionMode)
          expect(TOOL_GATES).toContain(m.toolGate)
        }
      })
    })
  }
})

/** Shared translation assertions every adapter's catalog must pass. */
function assertBidirectional(cat: VendorModeCatalog): void {
  for (const m of cat.modes) {
    // forward: a declared token maps to its declared grid cell.
    expect(tokenToGrid(cat, m.token)).toEqual({ actionMode: m.actionMode, toolGate: m.toolGate })
    // round-trip at the grid level: reverse-mapping the token's grid yields a token
    // whose grid is the SAME cell (tokens sharing a cell collapse, by design).
    const back = gridToToken(cat, { actionMode: m.actionMode, toolGate: m.toolGate })
    expect(isKnownToken(cat, back)).toBe(true)
    expect(tokenToGrid(cat, back)).toEqual({ actionMode: m.actionMode, toolGate: m.toolGate })
  }
  // unknown token degrades to the defaultToken's grid (total, never throws).
  expect(tokenToGrid(cat, '__nope__')).toEqual(tokenToGrid(cat, cat.defaultToken))
  // the reverse never crosses the action boundary: a plan grid resolves to a plan
  // token whenever the catalog declares one.
  if (cat.modes.some((m) => m.actionMode === 'plan')) {
    const planToken = gridToToken(cat, { actionMode: 'plan', toolGate: 'always-ask' })
    expect(tokenToGrid(cat, planToken).actionMode).toBe('plan')
  }
}

describe('claude token ⇄ grid', () => {
  it('translates bidirectionally', () => assertBidirectional(claudeModeCatalog))
  it('maps the five Agent-SDK tokens to the documented cells', () => {
    expect(tokenToGrid(claudeModeCatalog, 'plan')).toEqual({
      actionMode: 'plan',
      toolGate: 'on-sensitive',
    })
    expect(tokenToGrid(claudeModeCatalog, 'acceptEdits')).toEqual({
      actionMode: 'build',
      toolGate: 'trusted-prefix',
    })
    expect(tokenToGrid(claudeModeCatalog, 'bypassPermissions')).toEqual({
      actionMode: 'build',
      toolGate: 'never-ask',
    })
  })
  it('reverse-maps the shared build×on-sensitive cell to default (not auto)', () => {
    expect(gridToToken(claudeModeCatalog, { actionMode: 'build', toolGate: 'on-sensitive' })).toBe(
      'default',
    )
  })
  it('plan dominates the reverse regardless of gate', () => {
    expect(gridToToken(claudeModeCatalog, { actionMode: 'plan', toolGate: 'never-ask' })).toBe(
      'plan',
    )
  })
})

describe('codex token ⇄ grid', () => {
  it('translates bidirectionally', () => assertBidirectional(codexModeCatalog))
  it('maps read-only to a plan/read-only cell and full-access to never-ask', () => {
    expect(tokenToGrid(codexModeCatalog, 'read-only')).toEqual({
      actionMode: 'plan',
      toolGate: 'on-sensitive',
    })
    expect(tokenToGrid(codexModeCatalog, 'full-access')).toEqual({
      actionMode: 'build',
      toolGate: 'never-ask',
    })
  })
})

describe('opencode token ⇄ grid', () => {
  it('translates bidirectionally', () => assertBidirectional(opencodeModeCatalog))
  it('maps plan to the Plan agent cell and build-allow to never-ask', () => {
    expect(tokenToGrid(opencodeModeCatalog, 'plan')).toEqual({
      actionMode: 'plan',
      toolGate: 'on-sensitive',
    })
    expect(tokenToGrid(opencodeModeCatalog, 'build-allow')).toEqual({
      actionMode: 'build',
      toolGate: 'never-ask',
    })
  })
})
