// @vitest-environment happy-dom
/**
 * CreatePrOverlay — the create-PR progress overlay's presentation.
 *
 * It is a pure view over the reducer's model, so what matters here is that the
 * four steps render their done/active/pending markers, that it announces itself
 * as a busy modal dialog, and that it offers no way out (closing is the control
 * layer's job — a cancel control would imply the server task can be aborted).
 */
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREATE_PR_STEPS, type CreatePrModel } from '@/lib/create-pr-view'
import CreatePrOverlay from './CreatePrOverlay.vue'

// The SFC source, read from the repo root (Vitest's cwd) — see the last test.
const SFC_PATH = 'web/src/components/CreatePrOverlay/CreatePrOverlay.vue'

function model(phase: CreatePrModel['phase']): CreatePrModel {
  return { intentId: 'intent-1', requestId: 'req-1', phase, startedAt: 0, visibleAt: 0 }
}

describe('CreatePrOverlay', () => {
  it('renders nothing without a model', () => {
    const w = mount(CreatePrOverlay, { props: { model: null } })
    expect(w.find('[data-testid="create-pr-overlay"]').exists()).toBe(false)
  })

  it('renders the four steps with done, active and pending markers', () => {
    const w = mount(CreatePrOverlay, { props: { model: model('pushing') } })

    expect(w.findAll('.cpo-step')).toHaveLength(CREATE_PR_STEPS.length)
    expect(w.findAll('[data-status="done"]')).toHaveLength(2)
    expect(w.find('[data-status="done"] .cpo-check').text()).toBe('✓')
    expect(w.find('[data-status="active"] .cpo-spinner').exists()).toBe(true)
    expect(w.find('[data-status="pending"] .cpo-dot').exists()).toBe(true)
    // Every step is labelled — i18n resolves, no raw key leaks through.
    for (const step of w.findAll('.cpo-label')) {
      expect(step.text().length).toBeGreaterThan(0)
      expect(step.text()).not.toContain('intent.createPrProgress')
    }
  })

  it('marks all four steps done on the success phase', () => {
    const w = mount(CreatePrOverlay, { props: { model: model('done') } })
    expect(w.findAll('[data-status="done"]')).toHaveLength(CREATE_PR_STEPS.length)
    expect(w.find('.cpo-spinner').exists()).toBe(false)
  })

  it('announces a busy, labelled modal dialog and blocks with a titled panel', () => {
    const w = mount(CreatePrOverlay, { props: { model: model('committing') } })
    const overlay = w.get('[data-testid="create-pr-overlay"]')

    expect(overlay.attributes('role')).toBe('alertdialog')
    expect(overlay.attributes('aria-modal')).toBe('true')
    expect(overlay.attributes('aria-busy')).toBe('true')
    expect(overlay.attributes('aria-label')?.length).toBeGreaterThan(0)
    expect(w.find('.cpo-title').text().length).toBeGreaterThan(0)
  })

  it('offers no cancel or close control', () => {
    const w = mount(CreatePrOverlay, { props: { model: model('committing') } })
    expect(w.findAll('button')).toHaveLength(0)
    expect(w.findAll('a')).toHaveLength(0)
    expect(w.findAll('[role="button"]')).toHaveLength(0)
  })

  it('slows the spinner instead of removing it under reduced motion', () => {
    // Scoped CSS is not applied in happy-dom, so guard the rule at the source:
    // dropping it would silently reintroduce a fast spin for motion-sensitive users.
    const sfcSource = readFileSync(resolve(SFC_PATH), 'utf8')
    const block = sfcSource.match(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\{[^}]*\}[^}]*\}/,
    )
    expect(block?.[0]).toContain('.cpo-spinner')
    expect(block?.[0]).toContain('animation-duration')
  })
})
