// @vitest-environment happy-dom
/**
 * CreateIntentOverlay — the create-intent progress overlay's presentation.
 *
 * It is a pure view over the reducer's model, so what matters here is that the
 * four steps render their done/active/pending markers, that it announces itself
 * as a busy modal dialog, and that it offers no way out (closing is the control
 * layer's job — a cancel control would imply the server chain can be aborted).
 */
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREATE_INTENT_STEPS, type CreateIntentModel } from '@/lib/create-intent-view'
import CreateIntentOverlay from './CreateIntentOverlay.vue'

// The SFC source, read from the repo root (Vitest's cwd) — see the last test.
const SFC_PATH = 'web/src/components/CreateIntentOverlay/CreateIntentOverlay.vue'

function model(phase: CreateIntentModel['phase']): CreateIntentModel {
  return { phase, startedAt: 0, visibleAt: 0, stageAt: 0 }
}

describe('CreateIntentOverlay', () => {
  it('renders nothing without a model', () => {
    const w = mount(CreateIntentOverlay, { props: { model: null } })
    expect(w.find('[data-testid="create-intent-overlay"]').exists()).toBe(false)
  })

  it('renders the four steps with done, active and pending markers', () => {
    const w = mount(CreateIntentOverlay, { props: { model: model('create-intent') } })

    expect(w.findAll('.cio-step')).toHaveLength(CREATE_INTENT_STEPS.length)
    expect(w.findAll('[data-status="done"]')).toHaveLength(2)
    expect(w.find('[data-status="done"] .cio-check').text()).toBe('✓')
    expect(w.find('[data-status="active"] .cio-spinner').exists()).toBe(true)
    expect(w.find('[data-status="pending"] .cio-dot').exists()).toBe(true)
    // Every step is labelled — i18n resolves, no raw key leaks through.
    for (const step of w.findAll('.cio-label')) {
      expect(step.text().length).toBeGreaterThan(0)
      expect(step.text()).not.toContain('intent.createIntentProgress')
    }
  })

  it('marks all four steps done on the success phase', () => {
    const w = mount(CreateIntentOverlay, { props: { model: model('done') } })
    expect(w.findAll('[data-status="done"]')).toHaveLength(CREATE_INTENT_STEPS.length)
    expect(w.find('.cio-spinner').exists()).toBe(false)
  })

  it('announces a busy, labelled modal dialog and blocks with a titled panel', () => {
    const w = mount(CreateIntentOverlay, { props: { model: model('fetch-branch') } })
    const overlay = w.get('[data-testid="create-intent-overlay"]')

    expect(overlay.attributes('role')).toBe('alertdialog')
    expect(overlay.attributes('aria-modal')).toBe('true')
    expect(overlay.attributes('aria-busy')).toBe('true')
    expect(overlay.attributes('aria-label')?.length).toBeGreaterThan(0)
    expect(w.find('.cio-title').text().length).toBeGreaterThan(0)
  })

  it('offers no cancel or close control', () => {
    const w = mount(CreateIntentOverlay, { props: { model: model('fetch-branch') } })
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
    expect(block?.[0]).toContain('.cio-spinner')
    expect(block?.[0]).toContain('animation-duration')
  })
})
