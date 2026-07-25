import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import IntentDetailTabs from './IntentDetailTabs.vue'
import type { DetailTabItem } from './useIntentDetailTabs'

const TABS: DetailTabItem[] = [
  { key: 'intent', label: 'Intent' },
  { key: 'intentSession', label: 'Intent session' },
  { key: 'workSession', label: 'Work session' },
  { key: 'changelog', label: 'Changelog' },
]

function mountTabs(over: Record<string, unknown> = {}) {
  return mount(IntentDetailTabs, {
    props: {
      tabs: TABS,
      activeTab: 'intent',
      workSessionStatusDot: null,
      intentSessionStatusDot: null,
      ...over,
    },
  })
}

describe('IntentDetailTabs.vue', () => {
  it('renders the visible tabs and marks the active one', () => {
    const w = mountTabs({ activeTab: 'changelog' })
    expect(w.findAll('.intent-detail-tab').map((b) => b.attributes('data-tab'))).toEqual([
      'intent',
      'intentSession',
      'workSession',
      'changelog',
    ])
    expect(w.find('.intent-detail-tab[data-tab="changelog"]').classes()).toContain('active')
    expect(w.find('.intent-detail-tab[data-tab="changelog"]').attributes('aria-pressed')).toBe(
      'true',
    )
  })

  it('emits select with the clicked tab key', async () => {
    const w = mountTabs()
    await w.find('.intent-detail-tab[data-tab="workSession"]').trigger('click')
    expect(w.emitted('select')).toEqual([['workSession']])
  })

  it('shows session status dots only when provided, keyed to the right tab', () => {
    const w = mountTabs({
      workSessionStatusDot: 'running',
      intentSessionStatusDot: 'awaiting_permission',
    })
    const work = w.find('[data-testid="intent-detail-work-session-status"]')
    const intentDot = w.find('[data-testid="intent-detail-intent-session-status"]')
    expect(work.classes()).toContain('running')
    expect(intentDot.classes()).toContain('awaiting_permission')

    const none = mountTabs()
    expect(none.find('[data-testid="intent-detail-work-session-status"]').exists()).toBe(false)
    expect(none.find('[data-testid="intent-detail-intent-session-status"]').exists()).toBe(false)
  })
})
