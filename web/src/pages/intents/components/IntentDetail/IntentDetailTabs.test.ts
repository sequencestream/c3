import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import IntentDetailTabs from './IntentDetailTabs.vue'
import type { DetailTabItem } from './useIntentDetailTabs'

const TABS: DetailTabItem[] = [
  { key: 'intent', label: 'Intent' },
  { key: 'intentSession', label: 'Intent session' },
  { key: 'specSession', label: 'Spec session' },
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
      specSessionStatusDot: null,
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
      'specSession',
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
      specSessionStatusDot: 'team',
    })
    const work = w.find('[data-testid="intent-detail-work-session-status"]')
    const intentDot = w.find('[data-testid="intent-detail-intent-session-status"]')
    const specDot = w.find('[data-testid="intent-detail-spec-session-status"]')
    expect(work.classes()).toContain('running')
    expect(intentDot.classes()).toContain('awaiting_permission')
    expect(specDot.classes()).toContain('team')

    const none = mountTabs()
    expect(none.find('[data-testid="intent-detail-work-session-status"]').exists()).toBe(false)
    expect(none.find('[data-testid="intent-detail-intent-session-status"]').exists()).toBe(false)
    expect(none.find('[data-testid="intent-detail-spec-session-status"]').exists()).toBe(false)
  })

  it('scopes the spec session dot to the specSession tab, active or not', async () => {
    // 未激活 specSession(停在 intent tab):状态点仍只挂在 specSession 标签内。
    const w = mountTabs({ specSessionStatusDot: 'running' })
    const dots = w.findAll('[data-testid="intent-detail-spec-session-status"]')
    expect(dots).toHaveLength(1)
    expect(
      w.find('.intent-detail-tab[data-tab="specSession"]').find('.session-status').exists(),
    ).toBe(true)
    expect(w.find('.intent-detail-tab[data-tab="intent"]').find('.session-status').exists()).toBe(
      false,
    )

    // 激活 specSession 后同样只有一个点,且不牵动另外两类会话点。
    await w.setProps({ activeTab: 'specSession' })
    expect(w.findAll('[data-testid="intent-detail-spec-session-status"]')).toHaveLength(1)
    expect(w.find('[data-testid="intent-detail-intent-session-status"]').exists()).toBe(false)
    expect(w.find('[data-testid="intent-detail-work-session-status"]').exists()).toBe(false)
  })
})
